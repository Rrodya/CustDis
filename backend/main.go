package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	// Время, разрешенное для записи сообщения пиру.
	writeWait = 10 * time.Second

	// Время, разрешенное для чтения следующего pong сообщения от пира.
	pongWait = 60 * time.Second

	// Отправлять пинги пиру с этим периодом. Должно быть меньше pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Максимальный размер сообщения, разрешенный от пира.
	maxMessageSize = 1024 * 16 // Увеличим до 16KB для SDP с видео
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// ВАЖНО: Для продакшена здесь нужно проверять Origin!
		// Например: return r.Header.Get("Origin") == "http://yourdomain.com"
		return true // Пока разрешаем все origins для простоты разработки
	},
}

// Message определяет структуру для сообщений WebSocket (сигнализация)
type Message struct {
	Type     string      `json:"type"`              // Тип сообщения (offer, answer, candidate, user-joined, user-left, welcome, error)
	SenderID string      `json:"senderId,omitempty"` // ID отправителя (устанавливается сервером)
	TargetID string      `json:"targetId,omitempty"` // ID получателя (для offer, answer, candidate)
	Payload  interface{} `json:"payload"`           // Данные (SDP, ICE candidate, ID пользователя, список ID, текст ошибки)
}

// Client является промежуточным звеном между WebSocket соединением и хабом.
type Client struct {
	id   string // Уникальный ID клиента (присваивается хабом)
	hub  *Hub
	conn *websocket.Conn
	send chan Message // Канал для исходящих сообщений (типизированный)
}

// readPump считывает сообщения от WebSocket соединения к хабу.
func (c *Client) readPump() {
	defer func() {
		log.Printf("Клиент %s: Завершение readPump, отправка в unregister", c.id)
		c.hub.unregister <- c
		c.conn.Close()
		log.Printf("Клиент %s: readPump завершен, соединение закрыто", c.id)
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		// log.Printf("Клиент %s: Pong получен", c.id) // Опционально для отладки
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	log.Printf("Клиент %s: readPump запущен", c.id)
	for {
		// Читаем как обычное сообщение []byte
		messageType, messageBytes, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("Клиент %s: Ошибка чтения WebSocket (ожидаемое закрытие?): %v", c.id, err)
			} else {
				log.Printf("Клиент %s: Неожиданная ошибка чтения WebSocket: %v", c.id, err)
			}
			break // Выходим из цикла при любой ошибке чтения
		}

		// Игнорируем нетекстовые сообщения для простоты
		if messageType != websocket.TextMessage {
			log.Printf("Клиент %s: Получено нетекстовое сообщение (тип %d), игнорируется.", c.id, messageType)
			continue
		}

		// Декодируем JSON
		var msg Message
		if err := json.Unmarshal(messageBytes, &msg); err != nil {
			log.Printf("Клиент %s: ошибка декодирования JSON: %v, сообщение: %s", c.id, err, messageBytes)
			// Можно отправить сообщение об ошибке клиенту
			errMsg := Message{Type: "error", Payload: "Invalid JSON format"}
			// Попытка отправить ошибку (может заблокироваться, если writePump тоже упал)
			select {
			case c.send <- errMsg:
			default:
				log.Printf("Клиент %s: Не удалось отправить ошибку JSON (канал send заблокирован?)", c.id)
			}
			continue // Пропускаем некорректное сообщение
		}

		// Добавляем ID отправителя (если его еще нет - хотя он должен быть) и отправляем в хаб
		if c.id == "" {
			log.Printf("ВНИМАНИЕ: readPump получил сообщение до присвоения ID клиенту! Сообщение: %+v", msg)
			// Этого не должно происходить, если readPump запускается после присвоения ID
			continue
		}
		msg.SenderID = c.id
		log.Printf("Клиент %s: Получено: Тип=%s, Цель=%s. Отправка в хаб.", c.id, msg.Type, msg.TargetID)

		// Отправляем типизированное сообщение в хаб
		// Используем select, чтобы не блокировать readPump, если хаб перегружен (маловероятно)
		select {
		case c.hub.broadcast <- msg:
		default:
			log.Printf("Клиент %s: Не удалось отправить сообщение в хаб (канал broadcast заблокирован?)", c.id)
			// Если хаб не справляется, это серьезная проблема
		}
	}
}

// writePump передает сообщения от хаба к WebSocket соединению.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		// Не закрываем conn здесь, readPump сделает это при выходе
		// c.conn.Close()
		log.Printf("Клиент %s: writePump завершен", c.id)
	}()

	log.Printf("Клиент %s: writePump запущен", c.id)
	for {
		select {
		case msg, ok := <-c.send:
			// log.Printf("Клиент %s: writePump получил сообщение из канала send (ok=%t): %+v", c.id, ok, msg) // Для детальной отладки
			if !ok {
				// Хаб закрыл канал send.
				log.Printf("Клиент %s: Канал send закрыт хабом. Завершение writePump.", c.id)
				// Попытаемся отправить CloseMessage, но это может не сработать, если соединение уже разорвано
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			c.conn.SetWriteDeadline(time.Now().Add(writeWait))

			// Кодируем сообщение в JSON
			messageBytes, err := json.Marshal(msg)
			if err != nil {
				log.Printf("Клиент %s: Ошибка кодирования JSON для %+v: %v", c.id, msg, err)
				// Не возвращаемся, просто пропускаем это сообщение
				continue
			}

			// Используем TextMessage для JSON
			err = c.conn.WriteMessage(websocket.TextMessage, messageBytes)
			if err != nil {
				log.Printf("Клиент %s: Ошибка записи WebSocket: %v", c.id, err)
				// Возвращаемся, так как дальнейшая запись невозможна
				return
			}
			// log.Printf("Клиент %s: Успешно отправлено: Тип=%s, Цель=%s", c.id, msg.Type, msg.TargetID) // Для детальной отладки

			// Оптимизация: можно было бы считывать все сообщения из канала send
			// и записывать их батчем, но пока оставим просто.

		case <-ticker.C:
			// log.Printf("Клиент %s: Отправка Ping", c.id) // Опционально для отладки
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("Клиент %s: Ошибка отправки Ping: %v", c.id, err)
				return // Прекращаем работу при ошибке Ping
			}
		}
	}
}

// Hub поддерживает набор активных клиентов и рассылает им сообщения.
type Hub struct {
	clients    map[string]*Client // Зарегистрированные клиенты (ID -> Client)
	broadcast  chan Message       // Входящие сообщения от клиентов для маршрутизации
	register   chan *Client       // Канал для регистрации клиентов
	unregister chan *Client       // Канал для отмены регистрации клиентов
	mu         sync.RWMutex       // Мьютекс для безопасного доступа к карте clients
}

func newHub() *Hub {
	return &Hub{
		broadcast:  make(chan Message, 256), // Добавим буфер для broadcast
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[string]*Client),
	}
}

// sendMessageToClient безопасно отправляет сообщение клиенту.
// Использует неблокирующий select, чтобы не зависнуть, если канал клиента переполнен.
func (h *Hub) sendMessageToClient(client *Client, msg Message) bool {
	if client == nil {
		log.Printf("Попытка отправки сообщения nil клиенту: %+v", msg)
		return false
	}
	select {
	case client.send <- msg:
		// log.Printf("Хаб: Сообщение %+v поставлено в очередь для клиента %s", msg, client.id) // Для детальной отладки
		return true
	default:
		// Канал заблокирован, клиент не успевает обрабатывать сообщения.
		log.Printf("Хаб: Канал клиента %s заблокирован при попытке отправки %s. Помечаем на удаление.", client.id, msg.Type)
		// Возвращаем false, чтобы инициировать удаление клиента
		return false
	}
}

// broadcastMessage отправляет сообщение всем клиентам, кроме отправителя.
// Возвращает список клиентов, чьи каналы были заблокированы.
func (h *Hub) broadcastMessage(msg Message, senderId string) []*Client {
	h.mu.RLock() // Блокируем на чтение
	blockedClients := make([]*Client, 0)
	// log.Printf("Хаб: Рассылка %s от %s всем (%d клиентам)", msg.Type, senderId, len(h.clients)-1)

	for id, client := range h.clients {
		if id == senderId {
			continue // Не отправляем сообщение обратно отправителю
		}
		// Копируем сообщение, чтобы избежать гонок данных, если Payload - это map/slice
		// msgCopy := msg // Простое копирование структуры может быть недостаточно
		// Для безопасности можно перекодировать через JSON, но это медленно
		// Пока предполагаем, что Payload не изменяется после отправки в broadcast
		if !h.sendMessageToClient(client, msg) {
			// Если отправка не удалась (канал заблокирован), добавляем в список на удаление
			blockedClients = append(blockedClients, client)
		}
	}
	h.mu.RUnlock() // Разблокируем чтение
	return blockedClients
}

// unregisterClient безопасно удаляет клиента из хаба и закрывает его канал send.
// Должен вызываться только из основной горутины Hub.run().
func (h *Hub) unregisterClient(client *Client, reason string) {
	if client == nil {
		log.Println("Попытка отменить регистрацию nil клиента")
		return
	}
	clientId := client.id // Сохраняем ID для логов

	h.mu.Lock() // Блокируем на запись
	if _, ok := h.clients[clientId]; ok {
		delete(h.clients, clientId)
		// Закрываем канал send ТОЛЬКО если он еще не закрыт
		// (предотвращение паники при двойном закрытии)
		select {
		case _, ok := <-client.send:
			if ok { // Канал был открыт
				close(client.send)
				log.Printf("Хаб: Закрытие канала send для клиента %s", clientId)
			} else { // Канал уже был закрыт
				log.Printf("Хаб: Канал send для клиента %s уже был закрыт", clientId)
			}
		default: // Канал пуст и открыт
			close(client.send)
			log.Printf("Хаб: Закрытие пустого канала send для клиента %s", clientId)
		}
		log.Printf("Хаб: Клиент %s отменен (%s). Всего: %d", clientId, reason, len(h.clients))
	} else {
		log.Printf("Хаб: Попытка отменить регистрацию уже отсутствующего клиента %s", clientId)
	}
	h.mu.Unlock() // Разблокируем запись

	// Уведомляем остальных об уходе клиента (если ID был)
	if clientId != "" {
		leftMsg := Message{Type: "user-left", SenderID: clientId, Payload: clientId}
		log.Printf("Хаб: Уведомление об уходе клиента %s", clientId)
		// Рассылка может вернуть заблокированных клиентов, но мы их здесь не обрабатываем повторно,
		// так как это может привести к рекурсии или сложной логике блокировок.
		// Если другой клиент заблокирован при рассылке user-left, он будет удален
		// при следующей попытке отправки ему сообщения или по таймауту.
		h.broadcastMessage(leftMsg, clientId)
	}
}

// Основной цикл хаба
func (h *Hub) run() {
	log.Println("Хаб: Запуск основного цикла.")
	for {
		select {
		// Регистрация нового клиента
		case client := <-h.register:
			// Присваиваем ID
			client.id = uuid.New().String()
			log.Printf("Хаб: Регистрация клиента %s...", client.id)

			// Запускаем обработчики ДО добавления в map и отправки сообщений,
			// чтобы они были готовы принимать сообщения.
			go client.writePump()
			go client.readPump()

			// Добавляем клиента в map
			h.mu.Lock()
			h.clients[client.id] = client
			log.Printf("Хаб: Клиент %s добавлен в map. Всего: %d", client.id, len(h.clients))

			// Собираем ID уже подключенных пиров
			peerIDs := make([]string, 0, len(h.clients)-1)
			for id := range h.clients {
				if id != client.id {
					peerIDs = append(peerIDs, id)
				}
			}
			h.mu.Unlock() // Разблокируем map

			// 1. Отправляем новому клиенту 'welcome'
			welcomeMsg := Message{
				Type: "welcome",
				Payload: map[string]interface{}{
					"id":      client.id,
					"peerIds": peerIDs,
				},
			}
			log.Printf("Хаб: Попытка отправить welcome клиенту %s", client.id)
			if !h.sendMessageToClient(client, welcomeMsg) {
				// Если не удалось отправить welcome СРАЗУ, значит канал уже заблокирован.
				// Это странно, так как writePump только что запустился.
				// Логируем и немедленно удаляем клиента.
				log.Printf("Хаб: Канал клиента %s заблокирован СРАЗУ после запуска. Немедленная отмена регистрации.", client.id)
				// Прямой вызов unregisterClient здесь может привести к deadlock,
				// если run() заблокирован на h.mu.Lock() выше.
				// Безопаснее отправить в канал unregister.
				// Но так как мы только что разблокировали mu, можно вызвать напрямую.
				h.unregisterClient(client, "канал заблокирован при welcome")
				continue // Пропускаем отправку user-joined
			} else {
				log.Printf("Хаб: Сообщение welcome успешно поставлено в очередь для клиента %s", client.id)
			}

			// 2. Уведомляем остальных о новом пире
			joinedMsg := Message{Type: "user-joined", SenderID: client.id, Payload: client.id}
			log.Printf("Хаб: Уведомляем остальных (%d) о подключении %s", len(peerIDs), client.id)
			blocked := h.broadcastMessage(joinedMsg, client.id) // Отправляем всем, кроме нового

			// Обрабатываем заблокированных клиентов СРАЗУ после рассылки
			if len(blocked) > 0 {
				log.Printf("Хаб: Обнаружено %d заблокированных клиента при рассылке user-joined для %s", len(blocked), client.id)
				for _, blockedClient := range blocked {
					// Отменяем регистрацию заблокированных
					h.unregisterClient(blockedClient, "канал заблокирован при user-joined")
				}
			}

		// Отмена регистрации клиента
		case client := <-h.unregister:
			log.Printf("Хаб: Получен запрос на отмену регистрации клиента %s из readPump", client.id)
			h.unregisterClient(client, "запрос отмены регистрации из readPump")

		// Обработка входящих сообщений от клиентов
		case msg := <-h.broadcast:
			// log.Printf("Хаб: Получено сообщение из broadcast от %s: %+v", msg.SenderID, msg) // Для детальной отладки

			// Проверяем, существует ли отправитель (на случай, если он отключился между ReadMessage и отправкой в broadcast)
			h.mu.RLock()
			senderClient, senderExists := h.clients[msg.SenderID]
			h.mu.RUnlock()

			if !senderExists {
				log.Printf("Хаб: Получено сообщение от уже отключившегося клиента %s. Игнорируется.", msg.SenderID)
				continue
			}

			var blockedClients []*Client // Список для заблокированных клиентов

			if msg.TargetID != "" {
				// Адресное сообщение (offer, answer, candidate)
				h.mu.RLock()
				targetClient, found := h.clients[msg.TargetID]
				h.mu.RUnlock()

				if found {
					// log.Printf("Хаб: Пересылка %s от %s к %s", msg.Type, msg.SenderID, msg.TargetID)
					if !h.sendMessageToClient(targetClient, msg) {
						// Целевой клиент заблокирован, добавляем в список на удаление
						blockedClients = append(blockedClients, targetClient)
						log.Printf("Хаб: Целевой клиент %s заблокирован при пересылке %s", msg.TargetID, msg.Type)
					}
				} else {
					log.Printf("Хаб: Целевой клиент %s не найден для сообщения %s от %s", msg.TargetID, msg.Type, msg.SenderID)
					// Отправляем ошибку отправителю
					errorMsg := Message{Type: "error", Payload: "Target user " + msg.TargetID + " not found"}
					// Не нужно указывать TargetID для ошибки, она идет отправителю
					if !h.sendMessageToClient(senderClient, errorMsg) {
						// Отправитель тоже заблокирован
						blockedClients = append(blockedClients, senderClient)
						log.Printf("Хаб: Отправитель %s заблокирован при попытке отправить ошибку 'Target not found'", msg.SenderID)
					}
				}
			} else {
				// Сообщение для рассылки всем (если такие типы будут)
				// Например, текстовый чат
				// log.Printf("Хаб: Рассылка сообщения типа %s от %s", msg.Type, msg.SenderID)
				// blockedClients = h.broadcastMessage(msg, msg.SenderID)
				log.Printf("Хаб: Получено сообщение без TargetID от %s типа %s. Рассылка не реализована.", msg.SenderID, msg.Type)
			}

			// Отменяем регистрацию заблокированных клиентов после обработки сообщения
			if len(blockedClients) > 0 {
				log.Printf("Хаб: Обнаружено %d заблокированных клиента при обработке сообщения типа %s от %s", len(blockedClients), msg.Type, msg.SenderID)
				for _, blockedClient := range blockedClients {
					h.unregisterClient(blockedClient, "канал заблокирован при обработке broadcast")
				}
			}
		}
	}
}

// serveWs обрабатывает websocket запросы от пира.
func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("HTTP: Ошибка Upgrade:", err)
		return
	}
	log.Println("HTTP: WebSocket соединение установлено, создание клиента...")

	// Создаем клиента (ID будет присвоен в хабе)
	// Уменьшим буфер send, чтобы быстрее детектировать заблокированных клиентов
	client := &Client{hub: hub, conn: conn, send: make(chan Message, 32)}

	// Регистрируем клиента в хабе.
	// Хаб запустит обработчики (readPump/writePump) и начнет обмен сообщениями.
	hub.register <- client

	log.Println("HTTP: Клиент отправлен в канал register хаба.")
}

func main() {
	hub := newHub()
	go hub.run() // Запускаем хаб в отдельной горутине

	// Настраиваем обработчик для статических файлов из папки frontend
	// fs := http.FileServer(http.Dir(filepath.Join("..", "frontend")))
	// http.Handle("/", http.StripPrefix("/", fs)) // StripPrefix нужен, если frontend/index.html ссылается на app.js без /
	
	// Более простой способ раздачи статики, если исполняемый файл запускается из папки backend
	http.Handle("/", http.FileServer(http.Dir("../frontend")))


	// Настраиваем маршрут для WebSocket
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	port := ":8080"
	log.Printf("HTTP: Запуск сервера на http://localhost%s", port)
	err := http.ListenAndServe(port, nil)
	if err != nil {
		log.Fatal("HTTP: ListenAndServe: ", err)
	}
} 
// Логика JavaScript будет здесь
console.log('app.js загружен')

const connectButton = document.getElementById('connectButton')
const statusDiv = document.getElementById('status')
const remoteAudioContainer = document.getElementById('remoteAudioContainer')

let localStream = null
let ws = null
let peerConnections = {} // Словарь для хранения RTCPeerConnection для каждого пира
let myId = null // Наш ID, полученный от сервера
let isConnected = false

// --- WebSocket ---
function connectWebSocket() {
	// Определяем адрес WebSocket сервера
	const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const wsUrl = `${wsProtocol}//${window.location.host}/ws`
	console.log(`Подключение к WebSocket: ${wsUrl}`)

	ws = new WebSocket(wsUrl)

	ws.onopen = () => {
		console.log('WebSocket соединение установлено.')
		statusDiv.textContent = 'Статус: Подключен к сигнализации. Ожидание ID...'
		isConnected = true
		connectButton.textContent = 'Отключиться'
		// Запрос медиа и инициация WebRTC теперь происходит после получения 'welcome'
		// requestMediaPermissions();
	}

	ws.onmessage = event => {
		try {
			const message = JSON.parse(event.data)
			console.log('Сообщение от WebSocket:', message)
			handleSignalingData(message)
		} catch (error) {
			console.error(
				'Ошибка парсинга JSON от WebSocket:',
				error,
				'Данные:',
				event.data
			)
		}
	}

	ws.onerror = error => {
		console.error('WebSocket ошибка:', error)
		statusDiv.textContent = 'Статус: Ошибка WebSocket'
		disconnect()
	}

	ws.onclose = event => {
		console.log(
			'WebSocket соединение закрыто. Код:',
			event.code,
			'Причина:',
			event.reason
		)
		if (isConnected) {
			statusDiv.textContent = 'Статус: Отключен'
			isConnected = false
			connectButton.textContent = 'Подключиться'
			cleanupWebRTC()
			myId = null // Сбрасываем ID
		}
	}
}

function sendMessage(message) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		console.log('Отправка сообщения:', message)
		ws.send(JSON.stringify(message))
	} else {
		console.error(
			'Попытка отправить сообщение при закрытом WebSocket:',
			message
		)
	}
}

// --- WebRTC ---

async function requestMediaPermissionsAndConnectPeers(peerIds) {
	try {
		if (!localStream) {
			localStream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: false,
			})
			console.log('Доступ к микрофону получен.')
			statusDiv.textContent = 'Статус: Микрофон активен. Подключение к пирам...'
		} else {
			console.log('Локальный поток уже существует.')
		}

		// Инициируем соединения с пирами, которые были онлайн до нас
		peerIds.forEach(peerId => {
			if (peerId !== myId) {
				// Убедимся, что не пытаемся подключиться к себе
				initiatePeerConnection(peerId)
			}
		})
	} catch (error) {
		console.error(
			'Ошибка получения доступа к медиа или инициации соединений:',
			error
		)
		statusDiv.textContent = `Статус: Ошибка - ${error.message}`
		disconnect()
	}
}

// Инициирует соединение: создает PC, offer и отправляет его
async function initiatePeerConnection(peerId) {
	if (peerConnections[peerId]) {
		console.log(`Соединение с ${peerId} уже существует или инициируется.`)
		return
	}
	console.log(`Инициация соединения с ${peerId}`)
	const pc = createPeerConnection(peerId)

	try {
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		console.log(`Отправка offer пиру ${peerId}`)
		sendMessage({
			type: 'offer',
			payload: pc.localDescription,
			targetId: peerId,
		})
	} catch (error) {
		console.error(`Ошибка при создании/отправке offer для ${peerId}:`, error)
		// Закрыть PC если не удалось создать offer?
		pc.close()
		delete peerConnections[peerId]
	}
}

async function handleSignalingData(data) {
	const { type, senderId, targetId, payload } = data
	let pc

	console.log(`Обработка: тип=${type}, от=${senderId}, кому=${targetId}`)

	// Проверяем, адресовано ли сообщение нам (если есть targetId)
	if (targetId && targetId !== myId) {
		console.log('Сообщение не для нас.')
		return
	}

	switch (type) {
		case 'welcome':
			myId = payload.id
			console.log(`Получен ID: ${myId}`)
			statusDiv.textContent = `Статус: Подключен как ${myId}. Ожидание пиров...`
			await requestMediaPermissionsAndConnectPeers(payload.peerIds || [])
			break

		case 'user-joined':
			console.log(`Пользователь ${payload} присоединился.`)
			statusDiv.textContent = `Статус: Пользователь ${payload} присоединился.`
			// Инициация соединения происходит от нового пользователя (он получит наш ID в 'welcome')
			// Нам не нужно здесь создавать offer. Просто ждем.
			// Можно создать PC заранее, чтобы обработать offer быстрее, но необязательно.
			// createPeerConnection(payload);
			break

		case 'user-left':
			console.log(`Пользователь ${payload} отключился.`)
			statusDiv.textContent = `Статус: Пользователь ${payload} отключился.`
			pc = peerConnections[payload]
			if (pc) {
				pc.close()
				console.log(`PeerConnection для ${payload} закрыт.`)
				delete peerConnections[payload]
			}
			const audioEl = document.getElementById(`audio-${payload}`)
			if (audioEl) {
				audioEl.remove()
				console.log(`Аудио элемент для ${payload} удален.`)
			}
			break

		case 'offer':
			console.log(`Получен offer от ${senderId}`)
			pc = peerConnections[senderId]
			if (!pc) {
				console.log(
					`Создание PeerConnection для ${senderId} для ответа на offer.`
				)
				pc = createPeerConnection(senderId)
			} else {
				console.log(`PeerConnection для ${senderId} уже существует.`)
			}

			if (!localStream) {
				console.warn('Получен offer, но локальный поток еще не готов!')
				// По идее, к этому моменту localStream должен быть готов (после welcome)
				// Можно подождать или отклонить offer?
				// Пока просто продолжим, addTrack сработает позже, если поток появится
			}

			try {
				// Важно: сначала setRemoteDescription, потом createAnswer
				await pc.setRemoteDescription(new RTCSessionDescription(payload))
				console.log(`Remote description (offer) от ${senderId} установлен.`)
				const answer = await pc.createAnswer()
				await pc.setLocalDescription(answer)
				console.log(`Отправка answer пиру ${senderId}`)
				sendMessage({
					type: 'answer',
					payload: pc.localDescription,
					targetId: senderId,
				})
			} catch (error) {
				console.error(`Ошибка при обработке offer от ${senderId}:`, error)
			}
			break

		case 'answer':
			console.log(`Получен answer от ${senderId}`)
			pc = peerConnections[senderId]
			if (pc) {
				try {
					await pc.setRemoteDescription(new RTCSessionDescription(payload))
					console.log(
						`Remote description (answer) от ${senderId} установлен. Соединение установлено!`
					)
					statusDiv.textContent = `Статус: Соединено с ${senderId}` // Обновить статус
				} catch (error) {
					console.error(
						`Ошибка при установке remote description (answer) от ${senderId}:`,
						error
					)
				}
			} else {
				console.warn(
					`Получен answer от ${senderId}, но PeerConnection не найден.`
				)
			}
			break

		case 'candidate':
			console.log(`Получен ICE candidate от ${senderId}`)
			pc = peerConnections[senderId]
			if (pc) {
				try {
					if (payload) {
						// Убедимся, что кандидат не null
						await pc.addIceCandidate(new RTCIceCandidate(payload))
						console.log(`ICE candidate от ${senderId} добавлен.`)
					} else {
						console.log(
							`Получен пустой ICE candidate от ${senderId}. Игнорируем.`
						)
					}
				} catch (error) {
					// Игнорируем ошибки 'Error: Cannot add ICE candidate before setting remote description' и т.п.,
					// так как кандидаты могут приходить раньше установки описания
					if (!error.message.includes('before setting remote description')) {
						console.error(
							`Ошибка при добавлении ICE candidate от ${senderId}:`,
							error
						)
					}
				}
			} else {
				console.warn(
					`Получен candidate от ${senderId}, но PeerConnection не найден.`
				)
				// Возможно, стоит кешировать кандидатов, если они приходят до offer/answer
			}
			break

		case 'error': // Обработка ошибок от сервера
			console.error(`Получена ошибка от сервера: ${payload}`)
			statusDiv.textContent = `Статус: Ошибка сервера - ${payload}`
			// Можно предпринять действия в зависимости от типа ошибки
			break

		default:
			console.warn('Получен неизвестный тип сообщения:', type, data)
	}
}

function createPeerConnection(peerId) {
	// Проверяем, не существует ли уже соединение
	if (peerConnections[peerId]) {
		console.warn(`PeerConnection для ${peerId} уже существует.`)
		return peerConnections[peerId]
	}

	console.log(`Создание PeerConnection для ${peerId}`)
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
	})

	pc.onicecandidate = event => {
		if (event.candidate) {
			// Не отправляем кандидатов, пока не установлен remote description?
			// Хотя спецификация позволяет это.
			console.log(`Отправка ICE candidate для ${peerId}`)
			sendMessage({
				type: 'candidate',
				// Иногда payload может быть объектом, иногда строкой sdpMid, sdpMLineIndex
				// Отправляем весь объект event.candidate
				payload: event.candidate,
				targetId: peerId,
			})
		} else {
			console.log(`Все ICE кандидаты для ${peerId} отправлены.`)
		}
	}

	pc.oniceconnectionstatechange = () => {
		console.log(`ICE connection state для ${peerId}: ${pc.iceConnectionState}`)
		if (
			pc.iceConnectionState === 'failed' ||
			pc.iceConnectionState === 'disconnected' ||
			pc.iceConnectionState === 'closed'
		) {
			console.warn(`Соединение с ${peerId} разорвано или не удалось.`)
			// Можно попытаться переподключиться (ICE restart) или просто убрать пира
			const audioEl = document.getElementById(`audio-${peerId}`)
			if (audioEl) audioEl.remove()
			if (peerConnections[peerId]) {
				peerConnections[peerId].close()
				delete peerConnections[peerId]
			}
		}
		// Обновление статуса можно добавить здесь
		// statusDiv.textContent = `Статус: ${peerId} - ${pc.iceConnectionState}`;
	}

	pc.ontrack = event => {
		console.log(`Получен трек от ${peerId}`, event.streams)
		if (event.streams && event.streams[0]) {
			const existingAudio = document.getElementById(`audio-${peerId}`)
			if (existingAudio) {
				console.log(
					`Аудио элемент для ${peerId} уже существует. Обновляем поток.`
				)
				existingAudio.srcObject = event.streams[0]
			} else {
				console.log(`Создание аудио элемента для ${peerId}`)
				const remoteAudio = document.createElement('audio')
				remoteAudio.srcObject = event.streams[0]
				remoteAudio.autoplay = true
				// remoteAudio.controls = true; // Можно убрать контролы для чата
				remoteAudio.id = `audio-${peerId}`
				remoteAudioContainer.appendChild(remoteAudio)
				statusDiv.textContent = `Статус: Говорит ${peerId}`
			}
		} else {
			console.warn(`Событие ontrack для ${peerId} не содержит потоков.`)
		}
	}

	// Добавляем локальные треки, ЕСЛИ они уже есть
	if (localStream) {
		localStream.getTracks().forEach(track => {
			try {
				pc.addTrack(track, localStream)
				console.log(`Локальный трек добавлен для ${peerId}`)
			} catch (error) {
				console.error(`Ошибка добавления трека для ${peerId}:`, error)
			}
		})
	} else {
		console.warn(
			`PeerConnection для ${peerId} создан, но локальный поток еще не готов.`
		)
		// Треки будут добавлены позже? WebRTC должен справиться, если offer/answer
		// согласуются без треков сначала, а потом с ними (renegotiation).
	}

	peerConnections[peerId] = pc
	return pc
}

function cleanupWebRTC() {
	console.log('Очистка WebRTC ресурсов...')
	myId = null // Сбрасываем ID
	// Останавливаем локальный поток
	if (localStream) {
		localStream.getTracks().forEach(track => track.stop())
		localStream = null
		console.log('Локальный поток остановлен.')
	}

	// Закрываем все peer connections
	for (const peerId in peerConnections) {
		if (peerConnections[peerId]) {
			peerConnections[peerId].onicecandidate = null // Убираем обработчики
			peerConnections[peerId].ontrack = null
			peerConnections[peerId].oniceconnectionstatechange = null
			peerConnections[peerId].close()
			console.log(`PeerConnection для ${peerId} закрыт.`)
		}
	}
	peerConnections = {}

	// Удаляем аудио элементы
	remoteAudioContainer.innerHTML = ''
	console.log('Удаленные аудио элементы удалены.')
}

// --- Управление подключением ---

function connect() {
	if (isConnected) return
	console.log('Нажата кнопка Подключиться')
	statusDiv.textContent = 'Статус: Подключение к сигнализации...'
	connectWebSocket()
}

function disconnect() {
	console.log('Нажата кнопка Отключиться или произошло отключение')
	const explicitDisconnect = isConnected // Запоминаем, было ли инициировано пользователем
	if (ws) {
		// Не меняем isConnected здесь, ждем onclose
		ws.close(1000, 'Пользователь отключился') // Код 1000 - нормальное закрытие
		ws = null
	}
	// Очистку (cleanupWebRTC) теперь делает ws.onclose
	// Если ws уже был null, или закрытие не было явным,
	// то onclose мог не сработать или сработал из-за ошибки.
	// На всякий случай, если не были подключены, делаем cleanup.
	if (!explicitDisconnect) {
		statusDiv.textContent = 'Статус: Отключен'
		isConnected = false
		connectButton.textContent = 'Подключиться'
		cleanupWebRTC()
		myId = null
	}
}

connectButton.addEventListener('click', () => {
	if (isConnected) {
		disconnect()
	} else {
		connect()
	}
})

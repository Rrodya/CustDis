# 🚀 Руководство по развертыванию Voice Chat App

## Требования к серверу

- **ОС**: Ubuntu 20.04+ / CentOS 8+ / Debian 11+
- **RAM**: Минимум 1GB (рекомендуется 2GB+)
- **CPU**: 1 ядро (рекомендуется 2+)
- **Диск**: 10GB свободного места
- **Порты**: 80 (HTTP), 443 (HTTPS), 8080 (Backend API)

## 1. Подготовка сервера

### Установка Docker и Docker Compose

```bash
# Обновление системы
sudo apt update && sudo apt upgrade -y

# Установка Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Установка Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Перезагрузка для применения изменений группы
sudo reboot
```

### Настройка файрвола

```bash
# Установка UFW
sudo apt install ufw -y

# Настройка правил
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 8080

# Включение файрвола
sudo ufw enable
```

## 2. Загрузка проекта на сервер

### Вариант A: Через Git (рекомендуется)

```bash
# Клонирование репозитория
git clone <your-repo-url> voice-chat-app
cd voice-chat-app
```

### Вариант B: Через SCP/SFTP

```bash
# С локального компьютера
scp -r /path/to/your/project user@your-server:/home/user/voice-chat-app
```

## 3. Развертывание приложения

### Быстрое развертывание

```bash
# Переход в папку проекта
cd voice-chat-app

# Запуск скрипта развертывания
./deploy.sh
```

### Ручное развертывание

```bash
# Остановка существующих контейнеров
docker-compose down --remove-orphans

# Сборка и запуск
docker-compose up --build -d

# Проверка статуса
docker-compose ps
```

## 4. Настройка домена (опционально)

### Установка Nginx как reverse proxy

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

### Создание конфигурации Nginx

```bash
sudo nano /etc/nginx/sites-available/voice-chat
```

Добавьте конфигурацию:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://localhost:80/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

### Активация сайта и SSL

```bash
# Активация сайта
sudo ln -s /etc/nginx/sites-available/voice-chat /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Получение SSL сертификата
sudo certbot --nginx -d your-domain.com
```

## 5. Управление приложением

### Полезные команды

```bash
# Просмотр логов
docker-compose logs -f

# Остановка приложения
docker-compose down

# Перезапуск
docker-compose restart

# Обновление приложения
git pull
docker-compose up --build -d

# Просмотр использования ресурсов
docker stats
```

### Автоматический перезапуск

```bash
# Создание systemd сервиса
sudo nano /etc/systemd/system/voice-chat.service
```

Содержимое файла:

```ini
[Unit]
Description=Voice Chat App
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/user/voice-chat-app
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

Активация:

```bash
sudo systemctl enable voice-chat.service
sudo systemctl start voice-chat.service
```

## 6. Мониторинг и логирование

### Настройка логирования

```bash
# Создание папки для логов
mkdir -p /var/log/voice-chat

# Настройка ротации логов
sudo nano /etc/logrotate.d/voice-chat
```

Содержимое:

```
/var/log/voice-chat/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 644 root root
}
```

## 7. Резервное копирование

### Скрипт для бэкапа

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backup/voice-chat"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Бэкап конфигурации
tar -czf $BACKUP_DIR/config_$DATE.tar.gz \
    docker-compose.yml \
    nginx.conf \
    backend/ \
    frontend/

# Бэкап логов
tar -czf $BACKUP_DIR/logs_$DATE.tar.gz /var/log/voice-chat/

echo "Backup completed: $BACKUP_DIR"
```

## 8. Устранение неполадок

### Частые проблемы

1. **Порт 80 занят**

   ```bash
   sudo netstat -tulpn | grep :80
   sudo systemctl stop apache2  # если Apache запущен
   ```

2. **Проблемы с WebSocket**

   ```bash
   # Проверка конфигурации nginx
   sudo nginx -t
   sudo systemctl reload nginx
   ```

3. **Недостаточно памяти**

   ```bash
   # Очистка Docker
   docker system prune -a
   ```

4. **Проблемы с SSL**
   ```bash
   # Обновление сертификатов
   sudo certbot renew --dry-run
   ```

## 9. Обновление приложения

```bash
# Остановка приложения
docker-compose down

# Получение обновлений
git pull origin main

# Пересборка и запуск
docker-compose up --build -d

# Проверка статуса
docker-compose ps
```

## Контакты и поддержка

При возникновении проблем:

1. Проверьте логи: `docker-compose logs -f`
2. Убедитесь, что все порты открыты
3. Проверьте конфигурацию nginx
4. Обратитесь к документации Docker и Nginx

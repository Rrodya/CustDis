// Логика JavaScript будет здесь
console.log('app.js загружен')

const connectButton = document.getElementById('connectButton')
const shareScreenButton = document.getElementById('shareScreenButton')
const statusDiv = document.getElementById('status')
const remoteAudioContainer = document.getElementById('remoteAudioContainer')
const remoteVideoContainer = document.getElementById('remoteVideoContainer')

let localStream = null
let localScreenStream = null
let screenTrack = null
let ws = null
let peerConnections = {} // Словарь для хранения RTCPeerConnection для каждого пира
let myId = null // Наш ID, полученный от сервера
let isConnected = false
let isSharingScreen = false

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
		shareScreenButton.disabled = false
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
			shareScreenButton.disabled = true
			shareScreenButton.textContent = 'Поделиться экраном'
			isSharingScreen = false
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
			const audioContainer = document.getElementById(
				`audio-container-${payload}`
			)
			if (audioContainer) audioContainer.remove()
			const videoContainer = document.getElementById(
				`video-container-${payload}`
			)
			if (videoContainer) videoContainer.remove()
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
					if (payload && pc.remoteDescription) {
						await pc.addIceCandidate(new RTCIceCandidate(payload))
						console.log(`ICE candidate от ${senderId} добавлен.`)
					} else if (!payload) {
						console.log(
							`Получен пустой ICE candidate от ${senderId}. Игнорируем.`
						)
					} else if (!pc.remoteDescription) {
						console.warn(
							`Получен candidate от ${senderId}, но remote description еще не установлен. Игнорируем (или кешируем).`
						)
						// TODO: Можно реализовать кеширование кандидатов
					}
				} catch (error) {
					console.error(
						`Ошибка при добавлении ICE candidate от ${senderId}:`,
						error
					)
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

	// Обработчик для ре-негоциации (добавление/удаление треков)
	pc.onnegotiationneeded = async () => {
		console.log(`Сработало onnegotiationneeded для ${peerId}`)
		// Защита от слишком частых вызовов или race condition
		if (pc.signalingState !== 'stable') {
			console.warn(
				`onnegotiationneeded вызван в нестабильном состоянии (${pc.signalingState}) для ${peerId}, игнорируем.`
			)
			return
		}
		try {
			// Небольшая задержка перед созданием offer может помочь избежать race conditions
			await new Promise(resolve => setTimeout(resolve, 100))
			const offer = await pc.createOffer()
			// Проверим еще раз состояние перед setLocalDescription
			if (pc.signalingState !== 'stable') {
				console.warn(
					`Состояние изменилось на ${pc.signalingState} перед setLocalDescription для ${peerId}. Отмена offer.`
				)
				return
			}
			await pc.setLocalDescription(offer)
			console.log(`Отправка renegotiation offer пиру ${peerId}`)
			sendMessage({
				type: 'offer',
				payload: pc.localDescription,
				targetId: peerId,
			})
		} catch (error) {
			console.error(
				`Ошибка при renegotiation (createOffer/setLocalDescription) для ${peerId}:`,
				error
			)
		}
	}

	pc.onicecandidate = event => {
		if (event.candidate) {
			console.log(`Отправка ICE candidate для ${peerId}`)
			sendMessage({
				type: 'candidate',
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
			pc.iceConnectionState === 'connected' ||
			pc.iceConnectionState === 'completed'
		) {
			statusDiv.textContent = `Статус: Соединено с ${peerId}`
		}
		if (
			pc.iceConnectionState === 'failed' ||
			pc.iceConnectionState === 'disconnected' ||
			pc.iceConnectionState === 'closed'
		) {
			console.warn(
				`Соединение с ${peerId} разорвано или не удалось (${pc.iceConnectionState}).`
			)
			// Закрываем и удаляем PC, а также связанные элементы
			const audioContainer = document.getElementById(
				`audio-container-${peerId}`
			)
			if (audioContainer) audioContainer.remove()
			const videoContainer = document.getElementById(
				`video-container-${peerId}`
			)
			if (videoContainer) videoContainer.remove()
			if (peerConnections[peerId]) {
				peerConnections[peerId].close()
				delete peerConnections[peerId]
			}
			if (Object.keys(peerConnections).length === 0) {
				statusDiv.textContent = 'Статус: Соединений нет'
			}
		}
	}

	pc.ontrack = event => {
		console.log(
			`Получен трек от ${peerId}, kind: ${event.track.kind}, stream:`,
			event.streams[0]
		)
		if (!event.streams || !event.streams[0]) {
			console.warn(`Событие ontrack для ${peerId} не содержит потоков.`)
			return
		}
		const stream = event.streams[0]

		if (event.track.kind === 'audio') {
			const containerId = `audio-container-${peerId}`
			let audioContainer = document.getElementById(containerId)
			if (!audioContainer) {
				console.log(`Создание аудио контейнера для ${peerId}`)
				audioContainer = document.createElement('div')
				audioContainer.id = containerId
				audioContainer.classList.add('peer-audio') // Для возможных стилей

				const peerLabel = document.createElement('p')
				peerLabel.textContent = `Аудио от ${peerId.substring(0, 6)}...`
				peerLabel.style.margin = '0 0 5px 0'
				peerLabel.style.fontSize = '0.9em'

				const remoteAudio = document.createElement('audio')
				remoteAudio.autoplay = true
				remoteAudio.id = `audio-${peerId}`

				audioContainer.appendChild(peerLabel)
				audioContainer.appendChild(remoteAudio)
				remoteAudioContainer.appendChild(audioContainer)
				remoteAudio.srcObject = stream // Устанавливаем поток после добавления в DOM
			} else {
				console.log(
					`Аудио элемент для ${peerId} уже существует. Обновляем поток.`
				)
				const remoteAudio = audioContainer.querySelector('audio')
				if (remoteAudio) remoteAudio.srcObject = stream
			}
		} else if (event.track.kind === 'video') {
			const containerId = `video-container-${peerId}`
			let videoContainer = document.getElementById(containerId)
			if (!videoContainer) {
				console.log(`Создание видео контейнера для ${peerId}`)
				videoContainer = document.createElement('div')
				videoContainer.id = containerId
				videoContainer.classList.add('peer-video') // Класс для стилизации
				videoContainer.style.position = 'relative' // Для позиционирования кнопки

				const peerLabel = document.createElement('p')
				peerLabel.textContent = `Экран от ${peerId.substring(0, 6)}...`
				peerLabel.style.margin = '0 0 5px 0'
				peerLabel.style.fontSize = '0.9em'

				const remoteVideo = document.createElement('video')
				remoteVideo.autoplay = true
				remoteVideo.playsinline = true
				remoteVideo.muted = false
				remoteVideo.id = `video-${peerId}`
				remoteVideo.style.width = '100%' // Занимает ширину контейнера
				remoteVideo.style.display = 'block'

				const fullscreenButton = document.createElement('button')
				fullscreenButton.textContent = 'На весь экран'
				fullscreenButton.classList.add('fullscreen-btn')
				fullscreenButton.dataset.videoId = `video-${peerId}` // Связываем с видео
				// Стили кнопки лучше задать в CSS, но для примера:
				fullscreenButton.style.position = 'absolute'
				fullscreenButton.style.bottom = '10px'
				fullscreenButton.style.right = '10px'
				fullscreenButton.style.padding = '5px 8px'
				fullscreenButton.style.fontSize = '12px'
				fullscreenButton.style.cursor = 'pointer'
				fullscreenButton.style.zIndex = '1' // Поверх видео

				videoContainer.appendChild(peerLabel)
				videoContainer.appendChild(remoteVideo)
				videoContainer.appendChild(fullscreenButton)
				remoteVideoContainer.appendChild(videoContainer)
				remoteVideo.srcObject = stream // Устанавливаем поток
			} else {
				console.log(
					`Видео элемент для ${peerId} уже существует. Обновляем поток.`
				)
				const remoteVideo = videoContainer.querySelector('video')
				if (remoteVideo) remoteVideo.srcObject = stream
			}
		}
	}

	// Добавляем локальные АУДИО треки сразу
	if (localStream) {
		localStream.getTracks().forEach(track => {
			try {
				pc.addTrack(track, localStream)
				console.log(`Локальный аудио трек добавлен для ${peerId}`)
			} catch (error) {
				console.error(`Ошибка добавления аудио трека для ${peerId}:`, error)
			}
		})
	} else {
		console.warn(
			`PeerConnection для ${peerId} создан, но локальный аудио поток еще не готов.`
		)
	}

	// Добавляем локальный ВИДЕО трек, если мы уже шарим экран
	if (isSharingScreen && screenTrack) {
		try {
			pc.addTrack(screenTrack, localScreenStream)
			console.log(`Локальный видео (экран) трек добавлен для ${peerId}`)
		} catch (error) {
			console.error(
				`Ошибка добавления видео трека экрана для ${peerId}:`,
				error
			)
		}
	}

	peerConnections[peerId] = pc
	return pc
}

// --- Демонстрация экрана ---

async function startScreenShare() {
	if (isSharingScreen) {
		console.log('Уже идет демонстрация экрана.')
		return
	}
	try {
		localScreenStream = await navigator.mediaDevices.getDisplayMedia({
			video: true, // Запрашиваем видео
			audio: false, // Обычно звук с экрана не нужен, но можно запросить
		})
		console.log('Доступ к экрану получен.', localScreenStream)

		screenTrack = localScreenStream.getVideoTracks()[0]
		if (!screenTrack) {
			throw new Error('Не удалось получить видео трек экрана.')
		}

		isSharingScreen = true
		shareScreenButton.textContent = 'Остановить показ'
		statusDiv.textContent = 'Статус: Идет демонстрация экрана'

		// Добавляем трек ко всем существующим соединениям
		for (const peerId in peerConnections) {
			const pc = peerConnections[peerId]
			try {
				console.log(`Добавление трека экрана к соединению с ${peerId}`)
				pc.addTrack(screenTrack, localScreenStream)
				// pc.addTrack вызовет onnegotiationneeded, который отправит offer
			} catch (error) {
				console.error(
					`Ошибка добавления трека экрана к PC для ${peerId}:`,
					error
				)
			}
		}

		// Если пользователь остановит показ через UI браузера
		screenTrack.onended = () => {
			console.log('Демонстрация экрана остановлена пользователем (onended).')
			stopScreenShare(false) // Остановить без повторной попытки остановки трека
		}
	} catch (error) {
		console.error('Ошибка при запуске демонстрации экрана:', error)
		statusDiv.textContent = `Статус: Ошибка демонстрации экрана - ${error.message}`
		isSharingScreen = false // Сбрасываем флаг
	}
}

function stopScreenShare(stopTracks = true) {
	if (!isSharingScreen) {
		console.log('Демонстрация экрана не активна.')
		return
	}
	console.log('Остановка демонстрации экрана...')
	isSharingScreen = false
	shareScreenButton.textContent = 'Поделиться экраном'
	statusDiv.textContent = 'Статус: Демонстрация экрана остановлена'

	if (stopTracks && screenTrack) {
		console.log('Остановка локального трека экрана.')
		screenTrack.stop() // Останавливаем трек
	}
	screenTrack = null
	localScreenStream = null

	// Удаляем трек из всех соединений
	for (const peerId in peerConnections) {
		const pc = peerConnections[peerId]
		const senders = pc.getSenders() // Получаем все RTCRtpSender
		senders.forEach(sender => {
			if (sender.track && sender.track.kind === 'video') {
				// Находим видео sender
				try {
					console.log(`Удаление трека экрана из соединения с ${peerId}`)
					pc.removeTrack(sender)
					// pc.removeTrack вызовет onnegotiationneeded
				} catch (error) {
					console.error(
						`Ошибка удаления трека экрана из PC для ${peerId}:`,
						error
					)
				}
			}
		})
	}
	// На удаленной стороне видео должно пропасть после ре-негоциации,
	// но можно добавить явное сообщение, если будут проблемы.
}

// --- Очистка ---

function cleanupWebRTC() {
	console.log('Очистка WebRTC ресурсов...')
	stopScreenShare(true) // Останавливаем показ экрана, если он был активен
	myId = null
	if (localStream) {
		localStream.getTracks().forEach(track => track.stop())
		localStream = null
		console.log('Локальный аудио поток остановлен.')
	}

	for (const peerId in peerConnections) {
		if (peerConnections[peerId]) {
			peerConnections[peerId].onnegotiationneeded = null
			peerConnections[peerId].onicecandidate = null
			peerConnections[peerId].ontrack = null
			peerConnections[peerId].oniceconnectionstatechange = null
			peerConnections[peerId].close()
			console.log(`PeerConnection для ${peerId} закрыт.`)
		}
	}
	peerConnections = {}

	remoteAudioContainer.innerHTML = '<h2>Голоса собеседников</h2>' // Восстанавливаем заголовок
	remoteVideoContainer.innerHTML = '<h2>Экраны собеседников</h2>' // Восстанавливаем заголовок
	console.log('Удаленные аудио и видео элементы удалены.')
}

// --- Управление подключением и UI ---

function connect() {
	if (isConnected) return
	console.log('Нажата кнопка Подключиться')
	statusDiv.textContent = 'Статус: Подключение к сигнализации...'
	connectWebSocket()
}

function disconnect() {
	console.log('Нажата кнопка Отключиться или произошло отключение')
	const explicitDisconnect = isConnected
	if (ws) {
		ws.close(1000, 'Пользователь отключился')
		ws = null
	}
	if (!explicitDisconnect) {
		statusDiv.textContent = 'Статус: Отключен'
		isConnected = false
		connectButton.textContent = 'Подключиться'
		shareScreenButton.disabled = true
		shareScreenButton.textContent = 'Поделиться экраном'
		isSharingScreen = false
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

shareScreenButton.addEventListener('click', () => {
	if (isSharingScreen) {
		stopScreenShare()
	} else {
		startScreenShare()
	}
})

// --- Обработчик Fullscreen ---
remoteVideoContainer.addEventListener('click', event => {
	if (event.target && event.target.classList.contains('fullscreen-btn')) {
		const videoId = event.target.dataset.videoId
		const videoElement = document.getElementById(videoId)
		if (videoElement && videoElement.requestFullscreen) {
			videoElement.requestFullscreen().catch(err => {
				console.error(
					`Ошибка при попытке входа в полноэкранный режим для ${videoId}:`,
					err
				)
				alert(`Не удалось войти в полноэкранный режим: ${err.message}`)
			})
		} else if (videoElement) {
			console.warn(
				'Метод requestFullscreen не поддерживается этим элементом или браузером.'
			)
			alert('Полноэкранный режим не поддерживается.')
		} else {
			console.error(`Видео элемент с ID ${videoId} не найден для fullscreen.`)
		}
	}
})

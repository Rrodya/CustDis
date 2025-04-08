// Логика JavaScript будет здесь
console.log('app.js загружен')

const connectButton = document.getElementById('connectButton')
const shareScreenButton = document.getElementById('shareScreenButton')
const muteButton = document.getElementById('muteButton')
const statusDiv = document.getElementById('status')
const remoteAudioContainer = document.getElementById('remoteAudioContainer')
const remoteVideoContainer = document.getElementById('remoteVideoContainer')

let localStream = null
let localScreenStream = null
let screenVideoTrack = null
let screenAudioTrack = null
let screenAudioOnlyStream = null
let ws = null
let peerConnections = {} // Словарь для хранения RTCPeerConnection для каждого пира
let myId = null // Наш ID, полученный от сервера
let isConnected = false
let isSharingScreen = false
let isMuted = false

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
		connectButton.classList.add('connected')
		shareScreenButton.disabled = false
		muteButton.disabled = false
		updateMuteButton()
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
			statusDiv.textContent = 'Статус: Не подключен'
			isConnected = false
			connectButton.textContent = 'Подключиться'
			connectButton.classList.remove('connected')
			shareScreenButton.disabled = true
			shareScreenButton.textContent = 'Поделиться экраном'
			shareScreenButton.classList.remove('sharing')
			muteButton.disabled = true
			isSharingScreen = false
			isMuted = false
			updateMuteButton()
			cleanupWebRTC()
			myId = null
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
			setMuted(isMuted)
		} else {
			console.log('Локальный поток аудио уже существует.')
		}
		statusDiv.textContent = 'Статус: Микрофон активен.'

		// Инициируем соединения с пирами, которые были онлайн до нас
		peerIds.forEach(peerId => {
			if (peerId !== myId) {
				initiatePeerConnection(peerId)
			}
		})
	} catch (error) {
		console.error('Ошибка получения доступа к медиа:', error)
		statusDiv.textContent = `Статус: Ошибка микрофона - ${error.message}`
		muteButton.disabled = true
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
			statusDiv.textContent = `Статус: Подключен как ${myId}.`
			await requestMediaPermissionsAndConnectPeers(payload.peerIds || [])
			break

		case 'user-joined':
			console.log(`Пользователь ${payload} присоединился.`)
			statusDiv.textContent = `Статус: Пользователь ${payload} онлайн.`
			break

		case 'user-left':
			console.log(`Пользователь ${payload} отключился.`)
			pc = peerConnections[payload]
			if (pc) {
				pc.close()
				console.log(`PeerConnection для ${payload} закрыт.`)
				delete peerConnections[payload]
			}
			const audioCard = document.getElementById(`participant-${payload}`)
			if (audioCard) audioCard.remove()
			const videoContainer = document.getElementById(
				`video-container-${payload}`
			)
			if (videoContainer) videoContainer.remove()
			if (Object.keys(peerConnections).length === 0) {
				statusDiv.textContent = 'Статус: Соединений нет'
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
				console.warn('Получен offer, но локальный аудио поток еще не готов!')
			}

			try {
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
					} else if (payload) {
						console.log(
							`Получен пустой ICE candidate от ${senderId}. Игнорируем.`
						)
					} else if (!pc.remoteDescription) {
						console.warn(
							`Получен candidate от ${senderId}, но remote description еще не установлен. Игнорируем (или кешируем).`
						)
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
			}
			break

		case 'error': // Обработка ошибок от сервера
			console.error(`Получена ошибка от сервера: ${payload}`)
			statusDiv.textContent = `Статус: Ошибка сервера - ${payload}`
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
		const connectedStates = ['connected', 'completed']
		const disconnectedStates = ['failed', 'disconnected', 'closed']

		if (connectedStates.includes(pc.iceConnectionState)) {
			statusDiv.textContent = `Статус: Соединено`
		} else if (disconnectedStates.includes(pc.iceConnectionState)) {
			console.warn(
				`Соединение с ${peerId} разорвано или не удалось (${pc.iceConnectionState}).`
			)
			const audioCard = document.getElementById(`participant-${peerId}`)
			if (audioCard) audioCard.remove()
			const videoContainer = document.getElementById(
				`video-container-${peerId}`
			)
			if (videoContainer) videoContainer.remove()
			if (peerConnections[peerId]) {
				peerConnections[peerId].close()
				delete peerConnections[peerId]
			}
			if (Object.keys(peerConnections).length === 0 && isConnected) {
				statusDiv.textContent = 'Статус: Нет активных соединений'
			} else if (isConnected) {
				statusDiv.textContent = 'Статус: Соединено'
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
		const trackKind = event.track.kind

		if (trackKind === 'audio') {
			const cardId = `participant-${peerId}`
			const micAudioId = `audio-${peerId}`
			const screenAudioId = `screen-audio-${peerId}`
			let audioCard = document.getElementById(cardId)

			let micAudioElement = document.getElementById(micAudioId)

			if (!audioCard) {
				console.log(
					`Создание аудио карточки для ${peerId} и первого аудио элемента (микрофон)`
				)
				audioCard = document.createElement('div')
				audioCard.id = cardId
				audioCard.classList.add('participant-card')

				const peerLabel = document.createElement('p')
				peerLabel.textContent = `Участник ${peerId.substring(0, 6)}...`
				audioCard.appendChild(peerLabel)

				const remoteAudio = document.createElement('audio')
				remoteAudio.autoplay = true
				remoteAudio.id = micAudioId
				remoteAudio.srcObject = stream
				audioCard.appendChild(remoteAudio)
				remoteAudioContainer.appendChild(audioCard)
			} else {
				if (!micAudioElement) {
					console.log(
						`Карточка для ${peerId} есть, но нет аудио микрофона. Создаем.`
					)
					const remoteAudio = document.createElement('audio')
					remoteAudio.autoplay = true
					remoteAudio.id = micAudioId
					remoteAudio.srcObject = stream
					audioCard.appendChild(remoteAudio)
				} else {
					let screenAudioElement = document.getElementById(screenAudioId)
					if (!screenAudioElement) {
						console.log(
							`Создание ВТОРОГО аудио элемента (звук экрана) для ${peerId}`
						)
						const screenAudioLabel = document.createElement('span')
						screenAudioLabel.textContent = 'Звук с экрана: '
						screenAudioLabel.style.fontSize = '0.8em'

						screenAudioElement = document.createElement('audio')
						screenAudioElement.autoplay = true
						screenAudioElement.id = screenAudioId
						screenAudioElement.srcObject = stream

						micAudioElement.insertAdjacentElement(
							'afterend',
							screenAudioElement
						)
						micAudioElement.insertAdjacentElement('afterend', screenAudioLabel)
					} else {
						console.log(
							`Обновление потока для существующего аудио элемента (звук экрана) для ${peerId}`
						)
						screenAudioElement.srcObject = stream
					}
				}
			}
		} else if (trackKind === 'video') {
			const containerId = `video-container-${peerId}`
			let videoContainer = document.getElementById(containerId)
			if (!videoContainer) {
				console.log(`Создание видео контейнера для ${peerId}`)
				videoContainer = document.createElement('div')
				videoContainer.id = containerId
				videoContainer.classList.add('peer-video')

				const peerLabel = document.createElement('p')
				peerLabel.textContent = `Экран от ${peerId.substring(0, 6)}...`

				const remoteVideo = document.createElement('video')
				remoteVideo.autoplay = true
				remoteVideo.playsinline = true
				remoteVideo.muted = false
				remoteVideo.id = `video-${peerId}`
				remoteVideo.srcObject = stream

				const fullscreenButton = document.createElement('button')
				fullscreenButton.textContent = 'На весь экран'
				fullscreenButton.classList.add('fullscreen-btn')
				fullscreenButton.dataset.videoId = `video-${peerId}`

				videoContainer.appendChild(peerLabel)
				videoContainer.appendChild(remoteVideo)
				videoContainer.appendChild(fullscreenButton)
				remoteVideoContainer.appendChild(videoContainer)
			} else {
				const remoteVideo = videoContainer.querySelector('video')
				if (remoteVideo) remoteVideo.srcObject = stream
			}
		}
	}

	// Добавляем локальные АУДИО треки сразу
	if (localStream) {
		localStream.getTracks().forEach(track => {
			if (track.kind === 'audio') {
				try {
					pc.addTrack(track, localStream)
				} catch (error) {
					console.error(`Ошибка добавления аудио трека для ${peerId}:`, error)
				}
			}
		})
	} else {
		console.warn(
			`PeerConnection для ${peerId} создан, но локальный аудио поток еще не готов.`
		)
	}

	// Добавляем локальные треки ЭКРАНА, если демонстрация активна
	if (isSharingScreen) {
		if (screenVideoTrack) {
			try {
				console.log(
					`Добавление существующего ВИДЕО трека экрана к новому соединению с ${peerId}`
				)
				pc.addTrack(screenVideoTrack, localScreenStream)
			} catch (error) {
				console.error(
					`Ошибка добавления существующего видео трека экрана для ${peerId}:`,
					error
				)
			}
		}
		if (screenAudioTrack && screenAudioOnlyStream) {
			try {
				console.log(
					`Добавление существующего АУДИО трека экрана (из отдельного стрима) к новому соединению с ${peerId}`
				)
				pc.addTrack(screenAudioTrack, screenAudioOnlyStream)
			} catch (error) {
				console.error(
					`Ошибка добавления существующего аудио трека экрана для ${peerId}:`,
					error
				)
			}
		}
	}

	peerConnections[peerId] = pc
	return pc
}

// --- Демонстрация экрана ---

async function startScreenShare() {
	if (!isConnected) {
		alert('Сначала подключитесь к серверу.')
		return
	}
	if (isSharingScreen) {
		console.log('Уже идет демонстрация экрана.')
		return
	}
	try {
		const displayMediaOptions = {
			video: {
				width: { ideal: 2560 },
				height: { ideal: 1440 },
				frameRate: { ideal: 60 },
			},
			audio: true,
		}

		localScreenStream = await navigator.mediaDevices.getDisplayMedia(
			displayMediaOptions
		)
		console.log(
			'Доступ к экрану получен с запрошенными опциями (1440p@60fps ideal, audio:true):',
			displayMediaOptions,
			localScreenStream
		)

		screenVideoTrack = localScreenStream.getVideoTracks()[0]
		screenAudioTrack = localScreenStream.getAudioTracks()[0]

		if (!screenVideoTrack) {
			throw new Error('Не удалось получить видео трек экрана.')
		}
		if (screenAudioTrack) {
			console.log('Аудио трек экрана ПОЛУЧЕН.')
			screenAudioOnlyStream = new MediaStream()
			screenAudioOnlyStream.addTrack(screenAudioTrack)
			console.log('Создан отдельный MediaStream для аудио трека экрана.')
		} else {
			console.warn(
				'Аудио трек экрана НЕ получен (возможно, не поддерживается или не разрешен).'
			)
			screenAudioOnlyStream = null
		}

		createLocalScreenPreview()

		isSharingScreen = true
		shareScreenButton.textContent = 'Остановить показ'
		shareScreenButton.classList.add('sharing')
		statusDiv.textContent = 'Статус: Демонстрация экрана...'

		for (const peerId in peerConnections) {
			const pc = peerConnections[peerId]
			try {
				console.log(`Добавление видео трека экрана к соединению с ${peerId}`)
				pc.addTrack(screenVideoTrack, localScreenStream)
				if (screenAudioTrack && screenAudioOnlyStream) {
					console.log(
						`Добавление АУДИО трека экрана (из отдельного стрима) к соединению с ${peerId}`
					)
					pc.addTrack(screenAudioTrack, screenAudioOnlyStream)
				}
			} catch (error) {
				console.error(
					`Ошибка добавления трека(ов) экрана к PC для ${peerId}:`,
					error
				)
			}
		}

		screenVideoTrack.onended = () => {
			console.log('Видео трек экрана остановлен пользователем (onended).')
			stopScreenShare(false)
		}
		if (screenAudioTrack) {
			screenAudioTrack.onended = () => {
				console.log('Аудио трек экрана остановлен пользователем (onended).')
				if (!isSharingScreen) {
					stopScreenShare(false)
				}
			}
		}
	} catch (error) {
		console.error('Ошибка при запуске демонстрации экрана:', error)
		statusDiv.textContent = `Статус: Ошибка демонстрации - ${error.message}`
		isSharingScreen = false
		shareScreenButton.classList.remove('sharing')
		shareScreenButton.textContent = 'Поделиться экраном'
		removeLocalScreenPreview()
		screenVideoTrack = null
		screenAudioTrack = null
		localScreenStream = null
		screenAudioOnlyStream = null
	}
}

function stopScreenShare(stopTracks = true) {
	if (!isSharingScreen) {
		return
	}
	removeLocalScreenPreview()
	console.log('Остановка демонстрации экрана...')
	isSharingScreen = false
	shareScreenButton.textContent = 'Поделиться экраном'
	shareScreenButton.classList.remove('sharing')
	statusDiv.textContent = 'Статус: Соединено'

	if (stopTracks) {
		if (screenVideoTrack) screenVideoTrack.stop()
		if (screenAudioTrack) screenAudioTrack.stop()
	}

	const stoppedVideoTrack = screenVideoTrack
	const stoppedAudioTrack = screenAudioTrack

	screenVideoTrack = null
	screenAudioTrack = null
	localScreenStream = null
	screenAudioOnlyStream = null

	for (const peerId in peerConnections) {
		const pc = peerConnections[peerId]
		try {
			const senders = pc.getSenders()
			senders.forEach(sender => {
				if (
					sender.track === stoppedVideoTrack ||
					sender.track === stoppedAudioTrack
				) {
					try {
						console.log(
							`Удаление трека (${sender.track?.kind}) экрана из соединения с ${peerId}`
						)
						pc.removeTrack(sender)
					} catch (removeError) {
						console.error(
							`Ошибка при вызове pc.removeTrack для ${peerId}:`,
							removeError
						)
					}
				}
			})
		} catch (error) {
			console.error(
				`Ошибка при получении senders или удалении треков для ${peerId}:`,
				error
			)
		}
	}
}

// --- ДОБАВЛЕНО: Функции для локального превью ---
const LOCAL_PREVIEW_VIDEO_ID = 'local-screen-preview'
const LOCAL_PREVIEW_CONTAINER_ID = 'local-screen-container'

function createLocalScreenPreview() {
	if (document.getElementById(LOCAL_PREVIEW_CONTAINER_ID)) return // Уже есть

	console.log('Создание локального превью демонстрации экрана...')
	const videoContainer = document.createElement('div')
	videoContainer.id = LOCAL_PREVIEW_CONTAINER_ID
	videoContainer.classList.add('peer-video', 'local-preview') // Добавляем класс для стилизации

	const label = document.createElement('p')
	label.textContent = 'Ваша демонстрация экрана (без звука)'

	const videoElement = document.createElement('video')
	videoElement.id = LOCAL_PREVIEW_VIDEO_ID
	videoElement.srcObject = localScreenStream
	videoElement.autoplay = true
	videoElement.playsinline = true
	videoElement.muted = true // ОЧЕНЬ ВАЖНО!

	videoContainer.appendChild(label)
	videoContainer.appendChild(videoElement)

	// Добавляем в начало контейнера видео
	remoteVideoContainer.prepend(videoContainer)
}

function removeLocalScreenPreview() {
	const previewContainer = document.getElementById(LOCAL_PREVIEW_CONTAINER_ID)
	if (previewContainer) {
		console.log('Удаление локального превью демонстрации экрана...')
		previewContainer.remove()
	}
}
// --------------------------------------------------

// --- Mute ---
function setMuted(muted) {
	isMuted = muted
	if (localStream) {
		localStream.getAudioTracks().forEach(track => {
			track.enabled = !isMuted
		})
		console.log(`Микрофон ${isMuted ? 'выключен' : 'включен'}`)
	}
	updateMuteButton()
}

function toggleMute() {
	setMuted(!isMuted)
}

function updateMuteButton() {
	if (isMuted) {
		muteButton.textContent = 'Вкл. микрофон'
		muteButton.classList.add('muted')
	} else {
		muteButton.textContent = 'Выкл. микрофон'
		muteButton.classList.remove('muted')
	}
}

// --- Очистка ---

function cleanupWebRTC() {
	console.log('Очистка WebRTC ресурсов...')
	stopScreenShare(true)
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
		}
	}
	peerConnections = {}

	remoteAudioContainer.innerHTML = ''
	remoteVideoContainer.innerHTML = ''
	console.log('Удаленные аудио и видео элементы удалены.')
}

// --- Управление подключением и UI ---

function connect() {
	if (isConnected) return
	console.log('Нажата кнопка Подключиться')
	statusDiv.textContent = 'Подключение к сигнализации...'
	connectWebSocket()
}

function disconnect() {
	console.log('Нажата кнопка Отключиться или произошло отключение')
	const explicitDisconnect = isConnected
	if (ws) {
		ws.close(1000, 'Пользователь отключился')
		ws = null
	}
	if (!explicitDisconnect && !isConnected) {
		cleanupWebRTC()
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

muteButton.addEventListener('click', toggleMute)

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

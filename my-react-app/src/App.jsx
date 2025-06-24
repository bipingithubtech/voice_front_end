import { useState, useEffect, useRef } from 'react'
import './App.css'

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState('disconnected')
  const [messages, setMessages] = useState([])
  const [isRecording, setIsRecording] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [audioQueue, setAudioQueue] = useState([])
  const [isPlayingAudio, setIsPlayingAudio] = useState(false)
  const [currentStatus, setCurrentStatus] = useState('Ready to connect')
  const [autoReconnect, setAutoReconnect] = useState(false)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const [wasListeningBeforeReconnect, setWasListeningBeforeReconnect] = useState(false)
  const [isWaitingToRestart, setIsWaitingToRestart] = useState(false)
  const [isResponsePending, setIsResponsePending] = useState(false)
  const wsRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const recognitionRef = useRef(null)
  const audioRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const WEBSOCKET_URL = "ws://localhost:8001/ws/ai-stream"
  const MAX_RECONNECT_ATTEMPTS = 5
  const RECONNECT_DELAY = 2000 // 2 seconds

  // Initialize speech recognition
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      recognitionRef.current = new SpeechRecognition()
      recognitionRef.current.continuous = false
      recognitionRef.current.interimResults = false
      recognitionRef.current.lang = 'en-US'

      recognitionRef.current.onstart = () => {
        setIsListening(true)
        setCurrentStatus('Listening...')
        setMessages(prev => [...prev, { type: 'system', content: 'Listening...', timestamp: new Date().toLocaleTimeString() }])
      }

      recognitionRef.current.onresult = (event) => {
        const transcript = event.results[0][0].transcript
        setCurrentStatus('Processing your request...')
        setMessages(prev => [...prev, { type: 'user', content: transcript, timestamp: new Date().toLocaleTimeString() }])
        setIsResponsePending(true)
        sendMessage(transcript)
      }

      recognitionRef.current.onerror = (event) => {
        console.error('Speech recognition error:', event.error)
        setCurrentStatus('Speech recognition error')
        setMessages(prev => [...prev, { type: 'error', content: `Speech recognition error: ${event.error}`, timestamp: new Date().toLocaleTimeString() }])
      }

      recognitionRef.current.onend = () => {
        setIsListening(false)
        // Only restart listening if no response is pending
        if (isConnected && !isResponsePending && !isPlayingAudio && !isWaitingToRestart) {
          startVoiceRecognition()
        }
      }
    } else {
      console.error('Speech recognition not supported')
      setCurrentStatus('Speech recognition not supported')
      setMessages(prev => [...prev, { type: 'error', content: 'Speech recognition not supported in this browser', timestamp: new Date().toLocaleTimeString() }])
    }
  }, [])

  // Strict FIFO audio playback using useEffect
  useEffect(() => {
    if (audioQueue.length > 0 && !isPlayingAudio) {
      setIsPlayingAudio(true)
      setCurrentStatus('Playing response...')
      const nextAudio = audioQueue[0]
      const audioUrl = URL.createObjectURL(nextAudio)
      const audio = new Audio(audioUrl)
      audioRef.current = audio
      
      // Stop any ongoing voice recognition before playing audio
      if (recognitionRef.current && (isListening || isRecording)) {
        try {
          recognitionRef.current.stop()
        } catch (error) {
          console.error('Error stopping recognition:', error)
        }
      }
      
      audio.play().catch(error => {
        console.error('Error playing audio:', error)
        setIsPlayingAudio(false)
        setCurrentStatus('Ready to listen')
        // Restart voice recognition after error with longer delay
        if (isConnected && wasListeningBeforeReconnect) {
          setTimeout(() => {
            startVoiceRecognition()
          }, 2000)
        }
      })
      
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl)
        setIsPlayingAudio(false)
        setAudioQueue(prevQueue => prevQueue.slice(1)) // Remove the played audio
        setIsResponsePending(false)
        setCurrentStatus('Audio finished, waiting to restart listening...')
        setIsWaitingToRestart(true)
        // Wait longer before restarting voice recognition to avoid picking up audio
        if (isConnected) {
          setTimeout(() => {
            setIsWaitingToRestart(false)
            setCurrentStatus('Ready to listen')
            // Removed direct call to startVoiceRecognition here
            // Fallback: if still not listening after 3 seconds, force restart
            setTimeout(() => {
              if (!isListening && isConnected && !isPlayingAudio) {
                console.log('Normal restart failed, trying force restart')
                forceRestartVoiceRecognition()
              }
            }, 3000)
          }, 2000) // Reduced delay to 2 seconds for better responsiveness
        } else {
          setIsWaitingToRestart(false)
          setCurrentStatus('Ready to listen')
        }
      }
    }
  }, [audioQueue, isConnected])

  // Automatically restart listening when isWaitingToRestart becomes false and conditions are right
  useEffect(() => {
    if (
      !isWaitingToRestart &&
      isConnected &&
      !isPlayingAudio &&
      !isResponsePending &&
      !isListening &&
      recognitionRef.current
    ) {
      startVoiceRecognition()
    }
  }, [isWaitingToRestart, isConnected, isPlayingAudio, isResponsePending, isListening])

  // Auto-reconnect logic
  useEffect(() => {
    if (autoReconnect && !isConnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 10000) // Exponential backoff, max 10s
      
      reconnectTimeoutRef.current = setTimeout(() => {
        setCurrentStatus(`Reconnecting... (Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`)
        connectWebSocket()
      }, delay)
    }

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
    }
  }, [autoReconnect, isConnected, reconnectAttempts])

  const startVoiceRecognition = () => {
    console.log('Attempting to start voice recognition:', {
      hasRecognition: !!recognitionRef.current,
      isConnected,
      isPlayingAudio,
      isListening,
      isRecording,
      isWaitingToRestart,
      isResponsePending
    })
    
    if (recognitionRef.current && isConnected && !isPlayingAudio && !isWaitingToRestart && !isResponsePending) {
      try {
        // Add a small delay to ensure audio is completely finished
        setTimeout(() => {
          if (recognitionRef.current && isConnected && !isPlayingAudio && !isWaitingToRestart && !isResponsePending) {
            recognitionRef.current.start()
            setWasListeningBeforeReconnect(true)
            console.log('Voice recognition started successfully')
          } else {
            console.log('Voice recognition start cancelled - conditions changed:', {
              hasRecognition: !!recognitionRef.current,
              isConnected,
              isPlayingAudio,
              isWaitingToRestart,
              isResponsePending
            })
          }
        }, 500)
      } catch (error) {
        console.error('Error starting voice recognition:', error)
        setCurrentStatus('Error starting voice recognition')
      }
    } else {
      console.log('Cannot start voice recognition - conditions not met:', {
        hasRecognition: !!recognitionRef.current,
        isConnected,
        isPlayingAudio,
        isListening,
        isRecording,
        isWaitingToRestart,
        isResponsePending
      })
    }
  }

  const forceRestartVoiceRecognition = () => {
    console.log('Force restarting voice recognition')
    
    // Stop current recognition if running
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (error) {
        console.error('Error stopping recognition during force restart:', error)
      }
    }
    
    // Reset states
    setIsListening(false)
    setIsRecording(false)
    setIsWaitingToRestart(false)
    
    // Reinitialize speech recognition
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      recognitionRef.current = new SpeechRecognition()
      recognitionRef.current.continuous = false
      recognitionRef.current.interimResults = false
      recognitionRef.current.lang = 'en-US'

      recognitionRef.current.onstart = () => {
        setIsListening(true)
        setCurrentStatus('Listening...')
        setMessages(prev => [...prev, { type: 'system', content: 'Listening...', timestamp: new Date().toLocaleTimeString() }])
      }

      recognitionRef.current.onresult = (event) => {
        const transcript = event.results[0][0].transcript
        setCurrentStatus('Processing your request...')
        setMessages(prev => [...prev, { type: 'user', content: transcript, timestamp: new Date().toLocaleTimeString() }])
        setIsResponsePending(true)
        sendMessage(transcript)
      }

      recognitionRef.current.onerror = (event) => {
        console.error('Speech recognition error:', event.error)
        setCurrentStatus('Speech recognition error')
        setMessages(prev => [...prev, { type: 'error', content: `Speech recognition error: ${event.error}`, timestamp: new Date().toLocaleTimeString() }])
      }

      recognitionRef.current.onend = () => {
        setIsListening(false)
      }
      
      // Start the new recognition
      setTimeout(() => {
        if (isConnected && !isPlayingAudio && !isResponsePending) {
          try {
            recognitionRef.current.start()
            setWasListeningBeforeReconnect(true)
            console.log('Voice recognition force restarted successfully')
          } catch (error) {
            console.error('Error in force restart:', error)
            setCurrentStatus('Error restarting voice recognition')
          }
        } else {
          console.log('Force restart cancelled - conditions changed:', {
            isConnected,
            isPlayingAudio,
            isResponsePending
          })
        }
      }, 1000)
    }
  }

  const connectWebSocket = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return
    }

    setConnectionStatus('connecting')
    setCurrentStatus('Connecting...')
    
    try {
      wsRef.current = new WebSocket(WEBSOCKET_URL)
      
      wsRef.current.onopen = () => {
        setIsConnected(true)
        setConnectionStatus('connected')
        setCurrentStatus('Connected! Ready to listen')
        setReconnectAttempts(0) // Reset reconnect attempts on successful connection
        
        // Start voice recognition if we were listening before
        if (wasListeningBeforeReconnect) {
          setTimeout(() => {
            startVoiceRecognition()
          }, 1000)
        }
        
        setMessages(prev => [...prev, { type: 'system', content: 'Connected to AI Assistant!', timestamp: new Date().toLocaleTimeString() }])
      }
      
      wsRef.current.onmessage = (event) => {
        try {
          if (event.data instanceof Blob) {
            setAudioQueue(prevQueue => [...prevQueue, event.data])
            setCurrentStatus('Response received, playing...')
            setMessages(prev => [...prev, { type: 'system', content: 'Audio response queued...', timestamp: new Date().toLocaleTimeString() }])
          } else {
            let messageContent = event.data
            try {
              const jsonData = JSON.parse(event.data)
              if (jsonData.text) {
                messageContent = jsonData.text
              } else if (jsonData.error) {
                setMessages(prev => [...prev, { type: 'error', content: `Error: ${jsonData.error}`, timestamp: new Date().toLocaleTimeString() }])
                return
              }
            } catch (e) {
              messageContent = event.data
            }
            setMessages(prev => [...prev, { type: 'ai', content: messageContent, timestamp: new Date().toLocaleTimeString() }])
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error)
          setCurrentStatus('Error processing response')
          setMessages(prev => [...prev, { type: 'error', content: 'Error processing message', timestamp: new Date().toLocaleTimeString() }])
        }
      }
      
      wsRef.current.onclose = (event) => {
        console.log('WebSocket closed with code:', event.code, 'reason:', event.reason)
        setIsConnected(false)
        setConnectionStatus('disconnected')
        
        // Store current listening state before disconnect
        const wasListening = isListening || wasListeningBeforeReconnect
        setWasListeningBeforeReconnect(wasListening)
        
        // Only show disconnect message if auto-reconnect is disabled
        if (!autoReconnect) {
          setCurrentStatus('Disconnected')
          setMessages(prev => [...prev, { type: 'system', content: 'Disconnected from AI Assistant', timestamp: new Date().toLocaleTimeString() }])
        } else {
          // Auto-reconnect logic
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            setReconnectAttempts(prev => prev + 1)
            setCurrentStatus(`Connection lost. Reconnecting... (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`)
            setMessages(prev => [...prev, { type: 'system', content: `Connection lost. Attempting to reconnect... (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`, timestamp: new Date().toLocaleTimeString() }])
          } else {
            setCurrentStatus('Max reconnection attempts reached')
            setMessages(prev => [...prev, { type: 'error', content: 'Max reconnection attempts reached. Please reconnect manually.', timestamp: new Date().toLocaleTimeString() }])
          }
        }
      }
      
      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error)
        setIsConnected(false)
        setConnectionStatus('error')
        
        if (!autoReconnect) {
          setCurrentStatus('Connection error')
          setMessages(prev => [...prev, { type: 'error', content: 'Connection error occurred', timestamp: new Date().toLocaleTimeString() }])
        }
      }
    } catch (error) {
      setIsConnected(false)
      setConnectionStatus('error')
      setCurrentStatus('Failed to connect')
      setMessages(prev => [...prev, { type: 'error', content: 'Failed to connect', timestamp: new Date().toLocaleTimeString() }])
      console.error('Connection error:', error)
    }
  }

  const disconnectWebSocket = () => {
    setAutoReconnect(false) // Disable auto-reconnect when manually disconnecting
    setReconnectAttempts(0)
    setWasListeningBeforeReconnect(false)
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Send disconnect signal to backend
      try {
        wsRef.current.send('disconnect')
      } catch (error) {
        console.error('Error sending disconnect signal:', error)
      }
      // Give a small delay for the signal to be sent
      setTimeout(() => {
        if (wsRef.current) {
          wsRef.current.close()
          wsRef.current = null
        }
      }, 100)
    } else if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
  }

  const sendMessage = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(message)
    }
  }

  const startRecording = async () => {
    if (!isConnected) {
      setCurrentStatus('Please connect to AI Assistant first')
      setMessages(prev => [...prev, { type: 'error', content: 'Please connect to AI Assistant first', timestamp: new Date().toLocaleTimeString() }])
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setIsRecording(true)
      setWasListeningBeforeReconnect(true)
      
      if (recognitionRef.current) {
        recognitionRef.current.start()
      }
    } catch (error) {
      console.error('Error accessing microphone:', error)
      setCurrentStatus('Error accessing microphone')
      setMessages(prev => [...prev, { type: 'error', content: 'Error accessing microphone. Please check permissions.', timestamp: new Date().toLocaleTimeString() }])
    }
  }

  const stopRecording = () => {
    setIsRecording(false)
    setWasListeningBeforeReconnect(false)
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
  }

  const handleMicClick = () => {
    if (isRecording || isListening) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  const handleConnect = () => {
    if (!isConnected) {
      setAutoReconnect(true) // Enable auto-reconnect when connecting
      connectWebSocket()
    } else {
      disconnectWebSocket()
    }
  }

  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
    }
  }, [])

  return (
    <div className="app-container">
      <div className="ai-assistant-interface">
        {/* Header with AI branding */}
        <div className="ai-header">
          <div className="ai-logo">
            <div className="ai-avatar">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                <line x1="9" y1="9" x2="9.01" y2="9"/>
                <line x1="15" y1="9" x2="15.01" y2="9"/>
              </svg>
            </div>
            <div className="ai-title">
              <h1>AI Assistant</h1>
              <p>Your intelligent voice companion</p>
            </div>
          </div>
        </div>

        {/* Connection Status */}
        <div className="connection-panel">
          <div className="status-display">
            <div className={`status-indicator ${connectionStatus}`}>
              <div className="status-dot"></div>
              <span className="status-text">
                {connectionStatus === 'connected' && 'Connected'}
                {connectionStatus === 'connecting' && 'Connecting...'}
                {connectionStatus === 'disconnected' && 'Disconnected'}
                {connectionStatus === 'error' && 'Connection Error'}
              </span>
            </div>
            <div className="current-status">{currentStatus}</div>
            {autoReconnect && !isConnected && reconnectAttempts > 0 && (
              <div className="reconnect-info">
                Auto-reconnect enabled • Attempt {reconnectAttempts}/{MAX_RECONNECT_ATTEMPTS}
              </div>
            )}
          </div>

          <button
            className={`connect-btn ${isConnected ? 'connected' : ''} ${connectionStatus === 'connecting' ? 'connecting' : ''}`}
            onClick={handleConnect}
            disabled={connectionStatus === 'connecting'}
          >
            {!isConnected && connectionStatus !== 'connecting' && (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
                Connect
              </>
            )}
            {isConnected && (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
                Disconnect
              </>
            )}
            {connectionStatus === 'connecting' && (
              <>
                <div className="loading-spinner"></div>
                Connecting...
              </>
            )}
          </button>
        </div>

        {/* Main Voice Interface */}
        {isConnected && (
          <div className="voice-interface">
            <div className="voice-visualizer">
              <div className={`voice-circle ${isRecording || isListening ? 'active' : ''} ${isPlayingAudio ? 'playing' : ''}`}>
                <div className="voice-waves">
                  <div className="wave wave-1"></div>
                  <div className="wave wave-2"></div>
                  <div className="wave wave-3"></div>
                </div>
                <div className="voice-icon">
                  {(isRecording || isListening) ? (
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                      <line x1="9" y1="9" x2="9.01" y2="9"/>
                      <line x1="15" y1="9" x2="15.01" y2="9"/>
                    </svg>
                  ) : isPlayingAudio ? (
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="5,3 19,12 5,21" fill="currentColor"/>
                    </svg>
                  ) : (
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  )}
                </div>
              </div>
            </div>

            <div className="voice-controls">
              <button
                className={`voice-btn ${isRecording || isListening ? 'recording' : ''} ${isPlayingAudio ? 'playing' : ''} ${isWaitingToRestart ? 'waiting' : ''}`}
                onClick={handleMicClick}
                disabled={!isConnected || isPlayingAudio || isWaitingToRestart}
              >
                {isWaitingToRestart ? 'Waiting to restart...' : 
                 (isRecording || isListening) ? 'Stop Listening' : 'Start Listening'}
              </button>
              <div className="voice-instructions">
                {isWaitingToRestart ? (
                  <p>Audio finished. Waiting before restarting listening...</p>
                ) : (
                  <>
                    <p>Click the button above or say "Hey Assistant" to start</p>
                    <p>Speak clearly and naturally</p>
                  </>
                )}
                {currentStatus === 'Speech recognition error' && (
                  <p style={{ color: 'red', marginTop: '10px' }}>
                    There was a problem with voice recognition. Please check your microphone and browser permissions, then try again.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Welcome Screen when not connected */}
        {!isConnected && (
          <div className="welcome-screen">
            <div className="welcome-content">
              <div className="welcome-icon">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <h2>Welcome to AI Assistant</h2>
              <p>Connect to start your voice conversation with AI</p>
              <div className="features">
                <div className="feature">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                  <span>Natural voice interaction</span>
                </div>
                <div className="feature">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                  <span>Intelligent responses</span>
                </div>
                <div className="feature">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                  <span>Real-time processing</span>
                </div>
                <div className="feature">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                  <span>Auto-reconnection</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App

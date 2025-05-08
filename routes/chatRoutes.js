const express = require('express')
const router = express.Router()
const chatController = require('../controllers/chatController')

// Auth routes
router.post('/signup', chatController.signup)
router.post('/login', chatController.login)

// Protect all routes below
router.use(chatController.authMiddleware)

// Conversations
router.post('/conversations', chatController.createConversation)
router.get('/conversations', chatController.getConversations)
router.get('/conversations/:id', chatController.getConversation)
router.delete('/conversations/:id', chatController.deleteConversation)

// Chat streaming
router.post('/chat-stream', chatController.sendMessageStream)

// Image upload
router.post('/upload-image', chatController.uploadMiddleware.single('image'), chatController.uploadImage)

module.exports = router

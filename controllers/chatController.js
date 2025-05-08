const Conversation = require('../models/conversation')
const User = require('../models/user')
const { Configuration, OpenAIApi } = require('openai')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const path = require('path')
const fs = require('fs')

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
})
const openai = new OpenAIApi(configuration)

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret'

// --- Auth Controllers ---

exports.signup = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const existingUser = await User.findOne({ email })
    if (existingUser) return res.status(400).json({ error: 'Email already registered' })

    const user = new User({ email, password })
    await user.save()

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, email: user.email })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const user = await User.findOne({ email })
    if (!user) return res.status(400).json({ error: 'Invalid credentials' })

    const isMatch = await user.comparePassword(password)
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' })

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, email: user.email })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// Middleware to protect routes
exports.authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' })

  const token = authHeader.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Token missing' })

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.userId = decoded.id
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// --- Conversation Controllers ---

exports.createConversation = async (req, res) => {
  try {
    const conversation = new Conversation({ user: req.userId })
    await conversation.save()
    res.status(201).json(conversation)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({ user: req.userId }).sort({
      updatedAt: -1,
    })
    res.json(conversations)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.getConversation = async (req, res) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      user: req.userId,
    })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    res.json(conversation)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.deleteConversation = async (req, res) => {
  try {
    const conversation = await Conversation.findOneAndDelete({
      _id: req.params.id,
      user: req.userId,
    })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    res.json({ message: 'Deleted' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// --- Streaming Chat ---

exports.sendMessageStream = async (req, res) => {
  try {
    const { conversationId, message } = req.body
    if (!message || !conversationId) return res.status(400).json({ error: 'Missing conversationId or message' })

    const conversation = await Conversation.findOne({
      _id: conversationId,
      user: req.userId,
    })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })

    // Add user message
    conversation.messages.push({ role: 'user', content: message })
    await conversation.save()

    // Prepare messages for OpenAI
    const openaiMessages = conversation.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }))

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    let assistantMessage = ''

    const completion = await openai.createChatCompletion(
      {
        model: 'gpt-4o-mini', // replace with your GPT-4.1 model
        messages: openaiMessages,
        stream: true,
      },
      { responseType: 'stream' }
    )

    completion.data.on('data', (data) => {
      const lines = data
        .toString()
        .split('\n')
        .filter((line) => line.trim() !== '')

      for (const line of lines) {
        const message = line.replace(/^data: /, '')
        if (message === '[DONE]') {
          // Save assistant message to DB
          conversation.messages.push({
            role: 'assistant',
            content: assistantMessage,
          })
          conversation.save()
          res.write(`data: [DONE]\n\n`)
          res.end()
          return
        }
        try {
          const parsed = JSON.parse(message)
          const delta = parsed.choices[0].delta.content
          if (delta) {
            assistantMessage += delta
            res.write(`data: ${delta}\n\n`)
          }
        } catch (e) {
          // ignore JSON parse errors
        }
      }
    })

    completion.data.on('end', () => {
      if (!res.writableEnded) {
        res.write(`data: [DONE]\n\n`)
        res.end()
      }
    })

    completion.data.on('error', (err) => {
      console.error(err)
      if (!res.writableEnded) {
        res.write(`data: [ERROR]\n\n`)
        res.end()
      }
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// --- Image Upload ---

const multer = require('multer')

const uploadDir = path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`)
  },
})

exports.uploadMiddleware = multer({ storage })

exports.uploadImage = async (req, res) => {
  try {
    const { conversationId } = req.body
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const conversation = await Conversation.findOne({
      _id: conversationId,
      user: req.userId,
    })
    if (!conversation) {
      fs.unlinkSync(req.file.path)
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const imageUrl = `/uploads/${req.file.filename}`

    conversation.messages.push({
      role: 'user',
      content: '[Image]',
      imageUrl,
    })

    await conversation.save()

    res.json({ imageUrl, conversation })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

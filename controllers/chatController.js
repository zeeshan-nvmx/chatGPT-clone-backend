const Conversation = require('../models/conversation')
const User = require('../models/user')
const OpenAI = require('openai')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const path = require('path')
const crypto = require('crypto')
const NodeCache = require('node-cache')
const multer = require('multer')
const { uploadToS3, deleteFromS3 } = require('../utils/s3')

// Initialize OpenAI with v4 SDK
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// Initialize cache with 1 hour TTL
const responseCache = new NodeCache({ stdTTL: 3600 })

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret'

// Constants for token management
const MAX_TOKENS_PER_REQUEST = 900000 // Safe limit below 1M
const SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful AI assistant. Respond concisely when possible.',
}

// Approximate token counting function (better than nothing)
function estimateTokens(text) {
  return Math.ceil(text.length / 4) // Rough estimate: ~4 chars per token
}

// Conversation summarization function
async function summarizeConversation(messages) {
  try {
    // Create a system prompt instructing the model to summarize the conversation
    const summaryPrompt = [
      {
        role: 'system',
        content: 'Summarize the key points of this conversation history concisely, preserving important information that may be needed for future context.',
      },
      ...messages.slice(-20), // Use the last 20 messages for summary generation
    ]

    const summary = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Use a smaller model for summaries to reduce costs
      messages: summaryPrompt,
      max_tokens: 500,
    })

    return {
      role: 'system',
      content: `Conversation summary: ${summary.choices[0].message.content}`,
    }
  } catch (error) {
    console.error('Error generating summary:', error)
    return {
      role: 'system',
      content: `Previous conversation had ${messages.length} messages.`,
    }
  }
}

// Function to prepare messages for API, managing token count
async function prepareMessagesForAPI(conversation) {
  let messages = [...conversation.messages]
  let totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)

  // If we have system message in DB, use it, otherwise add default
  if (!messages.some((msg) => msg.role === 'system')) {
    messages.unshift(SYSTEM_MESSAGE)
    totalTokens += estimateTokens(SYSTEM_MESSAGE.content)
  }

  // If conversation is too long, summarize older messages
  if (totalTokens > MAX_TOKENS_PER_REQUEST) {
    const keepLastN = 20 // Always keep the most recent messages
    const messagesToKeep = messages.slice(-keepLastN)

    if (messages.length > keepLastN) {
      const oldMessages = messages.slice(0, -keepLastN)
      const summary = await summarizeConversation(oldMessages)

      // Replace old messages with summary
      messages = [messages.find((msg) => msg.role === 'system') || SYSTEM_MESSAGE, summary, ...messagesToKeep]

      // Update estimated token count
      totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)
    }
  }

  return { messages, totalTokens }
}

// Create hash for message caching
function createMessageHash(messages) {
  const lastFewMessages = messages.slice(-3) // Only use last 3 messages for cache key
  const concatenated = lastFewMessages.map((m) => `${m.role}:${m.content}`).join('|')
  return crypto.createHash('md5').update(concatenated).digest('hex')
}

// --- Auth Controllers (Updated for new user fields) ---

exports.signup = async (req, res) => {
  try {
    const { email, password, firstName, lastName, userName } = req.body

    // Check if all required fields are present
    if (!email || !password || !firstName || !lastName || !userName) {
      return res.status(400).json({ error: 'All fields are required: email, password, firstName, lastName, userName' })
    }

    // Check if email already exists
    const existingEmail = await User.findOne({ email })
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    // Check if username already exists
    const existingUserName = await User.findOne({ userName })
    if (existingUserName) {
      return res.status(400).json({ error: 'Username already taken' })
    }

    const user = new User({ email, password, firstName, lastName, userName })
    await user.save()

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' })
    res.json({
      token,
      user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        userName: user.userName,
      },
    })
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
    res.json({
      token,
      user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        userName: user.userName,
      },
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password')
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.updateUserProfile = async (req, res) => {
  try {
    const { firstName, lastName, userName } = req.body

    // Check if username already exists (if changing username)
    if (userName) {
      const existingUser = await User.findOne({ userName, _id: { $ne: req.userId } })
      if (existingUser) return res.status(400).json({ error: 'Username already taken' })
    }

    const updates = {}
    if (firstName) updates.firstName = firstName
    if (lastName) updates.lastName = lastName
    if (userName) updates.userName = userName

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true, runValidators: true }).select('-password')

    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

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

// --- Conversation Controllers (unchanged) ---

exports.createConversation = async (req, res) => {
  try {
    const conversation = new Conversation({ user: req.userId })

    // Initialize with a system message
    conversation.messages.push(SYSTEM_MESSAGE)

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

// Streaming Chat

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

    // Prepare response headers for streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    // Track the full response for saving to DB
    let assistantMessage = ''

    // Check cache for identical recent queries
    const messageHash = createMessageHash(conversation.messages)
    const cachedResponse = responseCache.get(messageHash)

    if (cachedResponse) {
      // If we have a cached response, stream it from cache
      console.log('Using cached response')

      // Stream the cached content in small chunks to simulate API response
      const chunks = cachedResponse.match(/.{1,20}/g) || []
      for (const chunk of chunks) {
        assistantMessage += chunk
        res.write(`data: ${chunk}\n\n`)
        // Small delay to simulate streaming
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      // Save the message to the conversation
      conversation.messages.push({
        role: 'assistant',
        content: cachedResponse,
      })
      await conversation.save()

      // End the stream
      res.write(`data: [DONE]\n\n`)
      res.end()
      return
    }

    try {
      // Prepare messages with token management
      const { messages, totalTokens } = await prepareMessagesForAPI(conversation)
      console.log(`Estimated tokens for request: ${totalTokens}`)

      // Create chat completion with v4 API
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // replace with your GPT-4.1 model when available
        messages: messages,
        stream: true,
      })

      // Process the stream with async iterator (v4 way)
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || ''
        if (content) {
          assistantMessage += content
          res.write(`data: ${content}\n\n`)
        }
      }

      // Cache the response for future use
      responseCache.set(messageHash, assistantMessage)

      // Save assistant message to DB
      conversation.messages.push({
        role: 'assistant',
        content: assistantMessage,
      })
      await conversation.save()

      // End the stream
      res.write(`data: [DONE]\n\n`)
      res.end()
    } catch (error) {
      console.error('OpenAI stream error:', error)
      if (!res.writableEnded) {
        res.write(`data: [ERROR]\n\n`)
        res.end()
      }
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// Image Upload (Updated for S3) 

// Configure multer for memory storage (not disk storage)
const storage = multer.memoryStorage()
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
      return res.status(404).json({ error: 'Conversation not found' })
    }

    // Generate a unique key for the file
    const fileExtension = req.file.originalname.split('.').pop()
    const key = `uploads/${req.userId}/${Date.now()}-${Math.round(Math.random() * 1e9)}.${fileExtension}`

    // Upload the file to S3
    const imageUrl = await uploadToS3(req.file, key)

    // Add to conversation
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

// Add method to delete image from S3
exports.deleteImage = async (req, res) => {
  try {
    const { imageKey } = req.body
    if (!imageKey) return res.status(400).json({ error: 'Image key is required' })

    // Extract key from the S3 URL
    const key = imageKey.split('/').slice(3).join('/')

    await deleteFromS3(key)
    res.json({ message: 'Image deleted successfully' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

const mongoose = require('mongoose')

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
    content: { type: String, required: true },
    imageUrl: { type: String },
    tokenCount: { type: Number }, // Store token count for each message
  },
  { timestamps: true }
)

const ConversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: 'New Conversation' },
    messages: [MessageSchema],
    totalTokensUsed: { type: Number, default: 0 }, // Track total tokens used in this conversation
    lastSummarizedAt: { type: Number, default: 0 }, // Index of message where last summarization occurred
  },
  { timestamps: true }
)

module.exports = mongoose.model('Conversation', ConversationSchema)

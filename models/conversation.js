const mongoose = require('mongoose')

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
    content: { type: String, required: true },
    imageUrl: { type: String },
  },
  { timestamps: true }
)

const ConversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: 'New Conversation' },
    messages: [MessageSchema],
  },
  { timestamps: true }
)

module.exports = mongoose.model('Conversation', ConversationSchema)

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const dotenv = require('dotenv');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const express = require('express');

dotenv.config();  // Load environment variables from .env file

const app = express();

// Set up logging with Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} - ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'whatsapp_bot.log' }),
        new winston.transports.Console()  // Log to console for debugging
    ]
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // Limit each IP to 10 requests per windowMs
    message: 'Rate limit exceeded. Please try again later.'
});

app.use('/webhook', limiter);

// MongoDB connection using the connection string from .env
const uri = process.env.MONGO_URI;
const clientMongo = new MongoClient(uri);

async function connectDB() {
    try {
        logger.info("Attempting to connect to MongoDB...");
        await clientMongo.connect();
        logger.info("Connected to MongoDB");
    } catch (error) {
        logger.error(`Failed to connect to MongoDB: ${error}`);
        process.exit(1);
    }
}

connectDB();

// Initialize OpenAI API
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,  // Ensure you have the OpenAI API key in your .env file
});

// Select your database and collection
const db = clientMongo.db("whatsappBotDB");
const conversationsCollection = db.collection("conversations");
const usersCollection = db.collection("users");

// WhatsApp Web client
const client = new Client({
    authStrategy: new LocalAuth()
});

// Add logging to check the WhatsApp client initialization
client.on('qr', (qr) => {
    logger.info("QR code received, generate it in terminal...");
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    logger.info('WhatsApp Web client is ready!');
});

client.on('message', async msg => {
    const sender = msg.from;
    const incomingMsg = msg.body.trim();

    logger.info(`Received message from ${sender}: ${incomingMsg}`);

    await updateConversationHistory(sender, incomingMsg, 'Human');

    const botResponse = await getBotResponse(sender, incomingMsg);
    msg.reply(botResponse);

    logger.info(`Sent response to ${sender}: ${botResponse}`);
});

client.on('disconnected', (reason) => {
    logger.warn(`WhatsApp Web client disconnected: ${reason}`);
});

client.initialize();

async function getUserProfile(sender) {
    let user = await usersCollection.findOne({ sender });
    if (!user) {
        user = { sender, preferences: {}, favoriteResponses: [], conversationHistory: [] };
        await usersCollection.insertOne(user);
    }
    return user;
}

async function updateConversationHistory(sender, message, role) {
    await conversationsCollection.updateOne(
        { sender },
        { $push: { history: { message, role, timestamp: new Date() } } },
        { upsert: true }
    );
}

async function getConversationHistory(sender) {
    const conversation = await conversationsCollection.findOne({ sender });
    if (conversation) {
        return conversation.history.slice(-20).map(entry => `${entry.role}: ${entry.message}`);
    }
    return [];
}

async function getBotResponse(sender, incomingMsg) {
    const user = await getUserProfile(sender);
    
    const history = await getConversationHistory(sender);
    history.push(`Human: ${incomingMsg}`);
    
    // Respond to "hi" with a simple greeting
    if (incomingMsg.toLowerCase() === "hi") {
        const response = "Hello! How can I assist you today? 😊";
        await updateConversationHistory(sender, response, 'Bot');
        return response;
    }

    // Respond when asked about the bot's creator
    if (incomingMsg.toLowerCase().includes("who are you")) {
        const response = `I'm a bot created by Patrick Attankurugu. But enough about me, what's on your mind today?`;
        await updateConversationHistory(sender, response, 'Bot');
        return response;
    }

    if (incomingMsg.toLowerCase().includes("tell me more about patrick")) {
        const response = `Patrick Attankurugu is a great guy, but let's not make this all about him. What's up with you? 😉`;
        await updateConversationHistory(sender, response, 'Bot');
        return response;
    }

    const prompt = `
    Here's the conversation history:
    ${history.join("\n")}

    Respond to the last message. Be fun, sarcastic, and engaging in your response.
    Keep it concise (1-2 sentences max).
    Avoid big words, use simple, everyday English.`;

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
    }).then(response => {
        const reply = response.choices[0].message.content.trim();
        return reply;
    }).catch(error => {
        logger.error(`OpenAI API error: ${error}`);
        return "Oops, something went wrong there! But hey, I'm still awesome, right? 😎";
    });

    await updateConversationHistory(sender, response, 'Bot');
    return response;
}

// Express routes for webhook and testing
app.post('/webhook', (req, res) => {
    logger.info("Webhook called");
    res.sendStatus(200);
});

app.get('/test', (req, res) => {
    logger.info('Test route accessed');
    res.status(200).send('WhatsApp bot is running!');
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error(`Unhandled exception: ${err.message}`);
    res.status(500).send('An unexpected error occurred');
});

app.listen(3000, () => {
    logger.info('Express server running on port 3000');
});

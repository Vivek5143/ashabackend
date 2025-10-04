// Load environment variables from .env file
require('dotenv').config();

// Import required libraries
const express = require('express');
const twilio = require('twilio');
const { Pool } = require('pg');
const OpenAI = require('openai');

// --- Initialize Clients ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

const openrouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": process.env.YOUR_APP_URL,
        "X-Title": process.env.YOUR_APP_NAME,
    },
});

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// --- Initialize Express App ---
const app = express();
const port = 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory store for conversation state
const conversationState = {};

// --- Main Voice Webhook for Handling the Call ---
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const userInput = req.body.SpeechResult;

    if (!conversationState[callSid]) {
        conversationState[callSid] = { history: [], collectedData: {} };
    }

    if (userInput) {
        conversationState[callSid].history.push({ role: 'user', content: userInput });
    }

    try {
        const llmResponse = await getLlmResponse(callSid);
        const responseData = JSON.parse(llmResponse.choices[0].message.content);
        
        Object.assign(conversationState[callSid].collectedData, responseData.extractedData);
        conversationState[callSid].history.push({ role: 'assistant', content: responseData.responseText });
        
        console.log('Current State:', conversationState[callSid].collectedData);

        if (responseData.isComplete) {
            await savePatientData(req.body.To, conversationState[callSid].collectedData);
            twiml.say(responseData.responseText);
            twiml.hangup();
            delete conversationState[callSid];
        } else {
            const gather = twiml.gather({
                input: 'speech', speechTimeout: 'auto', action: '/voice', method: 'POST',
            });
            gather.say(responseData.responseText);
        }
    } catch (error) {
        console.error('Error during LLM processing or TwiML generation:', error);
        twiml.say('I apologize, but I encountered an error. Please try again later.');
        twiml.hangup();
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// --- Helper function to interact with the LLM via OpenRouter ---
async function getLlmResponse(callSid) {
    const state = conversationState[callSid];
    const systemPrompt = `
        You are 'Asha', a friendly voice agent for the ASHA Sahayak program. Your task is to collect patient health information.
        
        Follow this script precisely:
        1. If full_name is missing, introduce yourself and ask for it.
        2. If age is missing, ask for it.
        3. If gender is missing, ask for it.
        // ... (rest of your detailed script from before) ...
        10. When all information is collected, say "Thank you for answering. We have recorded your details." and set isComplete to true.

        Rules:
        - Ask ONLY ONE question at a time.
        - Your response MUST be a valid JSON object with three keys: "responseText", "extractedData", and "isComplete".
    `;

    return openrouter.chat.completions.create({
        model: 'google/gemini-flash-1.5',
        messages: [
            { role: 'system', content: systemPrompt },
            ...state.history,
            { role: 'system', content: `Current collected data: ${JSON.stringify(state.collectedData)}. Now, determine the next question based on the script and the user's last answer. Generate the next JSON response.`}
        ],
        response_format: { type: "json_object" },
    });
}

// --- Helper function to save data to PostgreSQL ---
async function savePatientData(phoneNumber, data) {
    const query = `
        INSERT INTO patients (full_name, phone_number, address, health_condition)
        VALUES ($1, $2, $3, .env$4)
        ON CONFLICT (phone_number) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            address = EXCLUDED.address,
            health_condition = EXCLUDED.health_condition,
            created_at = NOW();
    `;
    const values = [data.full_name, phoneNumber, data.address, data.health_condition];
    try {
        await pool.query(query, values);
        console.log(`Successfully saved/updated data for ${phoneNumber}`);
    } catch (error) {
        console.error('Error saving data to database:', error);
    }
}


// --- API Endpoint to Initiate the Call (UPDATED) ---
app.post('/initiate-call', async (req, res) => {
    // We now expect the ngrokUrl to be sent from Postman
    const { phoneNumber, ngrokUrl } = req.body;

    if (!phoneNumber || !ngrokUrl) {
        return res.status(400).send({ message: 'Both phoneNumber and ngrokUrl are required.' });
    }
    
    // Construct the webhook URL dynamically
    const webhookUrl = `${ngrokUrl}/voice`; 

    console.log(`Request received. Attempting to call: ${phoneNumber}`);
    console.log(`Using webhook URL: ${webhookUrl}`);
    try {
        const call = await client.calls.create({ url: webhookUrl, to: phoneNumber, from: twilioPhoneNumber });
        console.log(`Call initiated successfully. Call SID: ${call.sid}`);
        res.status(200).json({ message: 'Call has been successfully initiated!', callSid: call.sid });
    } catch (error) {
        console.error('Error initiating call:', error);
        res.status(500).json({ message: 'Failed to initiate call.', error: error.message });
    }
});

// --- Start the Server ---
app.listen(port, () => {
    console.log(`✅ Backend server is running at http://localhost:${port}`);
});
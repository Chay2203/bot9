const express = require('express');
const OpenAI = require('openai');
const { Sequelize, DataTypes } = require('sequelize');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// OpenAI Configuration
const openai = new OpenAI({
  baseURL: "http://jamsapi.hackclub.dev/openai",
  apiKey: "4FUDH0OCU5AK9XPPN4C4TSOFT89F77NJV5TM7527VF01TSGIRRLU6MRUTSE4TYJR"
});

// Database setup
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './database.sqlite'
});

// Define User model
const User = sequelize.define('User', {
  userId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  fullName: DataTypes.STRING,
  email: DataTypes.STRING,
  lastInteraction: DataTypes.DATE
});

// Define Conversation model
const Conversation = sequelize.define('Conversation', {
  userId: DataTypes.STRING,
  messages: DataTypes.TEXT
});

// Define Booking model
const Booking = sequelize.define('Booking', {
  bookingId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  userId: DataTypes.STRING,
  roomId: DataTypes.INTEGER,
  checkInDate: DataTypes.DATE,
  checkOutDate: DataTypes.DATE,
  totalAmount: DataTypes.FLOAT,
  isPaid: DataTypes.BOOLEAN
});

// Sync database
sequelize.sync();

// Function to get rooms
async function getRooms() {
  try {
    const response = await axios.get('https://bot9assignement.deno.dev/rooms');
    return response.data;
  } catch (error) {
    console.error('Error fetching rooms:', error);
    return [];
  }
}

// Function to book a room
async function bookRoom(roomId, fullName, email, nights) {
  try {
    const response = await axios.post('https://bot9assignement.deno.dev/book', {
      roomId,
      fullName,
      email,
      nights
    });
    
    // Calculate check-out date
    const checkInDate = new Date();
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkOutDate.getDate() + nights);

    // Save booking details to our database
    await Booking.create({
      bookingId: response.data.bookingId,
      userId: email,
      roomId: roomId,
      checkInDate: checkInDate,
      checkOutDate: checkOutDate,
      totalAmount: response.data.totalPrice,
      isPaid: false
    });

    return response.data;
  } catch (error) {
    console.error('Error booking room:', error);
    return null;
  }
}

// Function to simulate payment gateway
async function processPayment(bookingId, amount, method) {
  try {
    // Simulate a call to a payment gateway API
    const gatewayResponse = await new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: Math.random() < 0.9, // 90% success rate
          transactionId: Math.random().toString(36).substr(2, 9).toUpperCase(),
          message: 'Payment processed successfully'
        });
      }, 1000); // Simulate a 1-second processing time
    });

    if (gatewayResponse.success) {
      // Update booking status in the database
      await Booking.update({ isPaid: true }, { where: { bookingId: bookingId } });
      return { 
        status: 'success', 
        message: `Payment of $${amount} processed via ${method}. Transaction ID: ${gatewayResponse.transactionId}` 
      };
    } else {
      return { 
        status: 'failed', 
        message: 'Payment processing failed. Please try again.' 
      };
    }
  } catch (error) {
    console.error('Error processing payment:', error);
    return { status: 'failed', message: 'An error occurred while processing the payment.' };
  }
}

// Chat endpoint
app.post('/chat', async (req, res) => {
  const { message, userId } = req.body;

  // Retrieve or create user
  let user = await User.findOne({ where: { userId } });
  if (!user) {
    user = await User.create({ userId, lastInteraction: new Date() });
  } else {
    await user.update({ lastInteraction: new Date() });
  }

  // Retrieve or create conversation
  let conversation = await Conversation.findOne({ where: { userId } });
  if (!conversation) {
    conversation = await Conversation.create({ userId, messages: '[]' });
  }

  let messages = JSON.parse(conversation.messages);
  messages.push({ role: 'user', content: message });

  const systemMessage = `
    You are a polite and helpful hotel booking assistant chatbot. Always maintain a friendly and professional tone.
    Key points:
    1. If asked "Who are you?", explain that you're a hotel booking assistant chatbot.
    2. If asked "Who am I?", provide details about the user if available.
    3. If faced with inappropriate language or queries, respond ethically and professionally, redirecting the conversation to booking-related topics.
    4. Guide users through the booking process: greeting, showing rooms, asking for nights of stay, calculating price, confirming booking, and processing payment.
    5. When a booking is confirmed, always provide the booking ID returned by the booking system to the user.
    6. Ask for payment after a booking is confirmed. Use the process_payment function to process payments.
    7. Provide check-in and check-out dates when asked or after a successful booking.
    8. You can communicate in any language the user prefers.
    User details: ${JSON.stringify(user)}
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...messages
      ],
      functions: [
        {
          name: "get_rooms",
          description: "Get available hotel rooms",
          parameters: { type: "object", properties: {} }
        },
        {
          name: "book_room",
          description: "Book a hotel room",
          parameters: {
            type: "object",
            properties: {
              roomId: { type: "number" },
              fullName: { type: "string" },
              email: { type: "string" },
              nights: { type: "number" }
            },
            required: ["roomId", "fullName", "email", "nights"]
          }
        },
        {
          name: "process_payment",
          description: "Process payment for a booking",
          parameters: {
            type: "object",
            properties: {
              bookingId: { type: "string" },
              amount: { type: "number" },
              method: { type: "string", enum: ["credit_card", "debit_card", "paypal"] }
            },
            required: ["bookingId", "amount", "method"]
          }
        }
      ],
      function_call: "auto",
    });

    let assistantMessage = completion.choices[0].message;

    if (assistantMessage.function_call) {
      const functionName = assistantMessage.function_call.name;
      const functionArgs = JSON.parse(assistantMessage.function_call.arguments);

      let functionResult;
      if (functionName === 'get_rooms') {
        functionResult = await getRooms();
      } else if (functionName === 'book_room') {
        functionResult = await bookRoom(
          functionArgs.roomId,
          functionArgs.fullName,
          functionArgs.email,
          functionArgs.nights
        );
        if (functionResult && functionResult.bookingId) {
          assistantMessage.content += ` Your booking ID is ${functionResult.bookingId}.`;
        }
      } else if (functionName === 'process_payment') {
        functionResult = await processPayment(
          functionArgs.bookingId,
          functionArgs.amount,
          functionArgs.method
        );
      }

      messages.push(assistantMessage);
      messages.push({
        role: "function",
        name: functionName,
        content: JSON.stringify(functionResult)
      });

      const secondCompletion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: messages
      });

      assistantMessage = secondCompletion.choices[0].message;
    }

    messages.push(assistantMessage);

    // Update conversation history
    await conversation.update({ messages: JSON.stringify(messages) });

    res.json({ response: assistantMessage.content });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ${PORT}'));
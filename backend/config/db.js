import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

export const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    logger.error('MONGODB_URI is not defined. Set the MONGODB_URI environment variable.');
    throw new Error('MONGODB_URI is not defined');
  }

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);

    logger.info(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    throw error;
  }
};

// Helper to expose connection state to other modules
export const isDBConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

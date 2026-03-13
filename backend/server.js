require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const leaveRoutes = require('./routes/leave');
const usersRoutes = require('./routes/users');
const notificationsRoutes = require('./routes/notifications');

const app = express();
// restrict CORS to known origins to avoid cross-origin errors
const allowedOrigins = [
	'https://leaveapplication.vercel.app',
	'https://leaveapplication-i0lt.onrender.com',
	'http://localhost:3000',
	'http://localhost:4000'
];

app.use(cors({
	origin: function(origin, callback) {
		// allow requests with no origin (like curl, mobile apps, or same-origin)
		if (!origin) return callback(null, true);
		if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
		return callback(new Error('CORS policy: This origin is not allowed'));
	}
}));

app.use(express.json());

connectDB();

app.use('/api/auth', authRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/notifications', notificationsRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'mySecretKey12345',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/classroom_notifier';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    rollNumber: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    year: { type: String, required: true },
    semester: { type: String, required: true },
    department: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const timetableSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    day: { type: String, required: true },
    slots: [{
        startTime: String,
        endTime: String,
        subject: String,
        faculty: String,
        building: String,
        roomNo: String
    }]
});

const settingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    emailEnabled: { type: Boolean, default: true },
    reminderTime: { type: Number, default: 10 },
    activeDays: {
        monday: { type: Boolean, default: true },
        tuesday: { type: Boolean, default: true },
        wednesday: { type: Boolean, default: true },
        thursday: { type: Boolean, default: true },
        friday: { type: Boolean, default: true },
        saturday: { type: Boolean, default: false },
        sunday: { type: Boolean, default: false }
    }
});

const User = mongoose.model('User', userSchema);
const Timetable = mongoose.model('Timetable', timetableSchema);
const Setting = mongoose.model('Setting', settingSchema);

// ==================== EMAIL SETUP ====================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
    }
});

// ==================== AUTH MIDDLEWARE ====================
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Please login first' });
    }
    next();
};

// ==================== API ROUTES ====================

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { name, rollNumber, email, password, year, semester, department } = req.body;
        
        const existingUser = await User.findOne({ $or: [{ email }, { rollNumber }] });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = new User({
            name, rollNumber, email, password: hashedPassword,
            year, semester, department
        });
        await user.save();
        
        const settings = new Setting({ userId: user._id });
        await settings.save();
        
        res.status(201).json({ success: true, message: 'Registration successful' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await User.findOne({
            $or: [{ email: username }, { rollNumber: username }]
        });
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        req.session.userId = user._id;
        req.session.userName = user.name;
        
        res.json({ success: true, redirect: '/dashboard.html' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Get user profile
app.get('/api/profile', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).select('-password');
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save timetable
app.post('/api/timetable', requireLogin, async (req, res) => {
    try {
        const { day, slots } = req.body;
        
        let timetable = await Timetable.findOne({ userId: req.session.userId, day });
        
        if (timetable) {
            timetable.slots = slots;
            await timetable.save();
        } else {
            timetable = new Timetable({
                userId: req.session.userId,
                day,
                slots
            });
            await timetable.save();
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get timetable
app.get('/api/timetable', requireLogin, async (req, res) => {
    try {
        const timetables = await Timetable.find({ userId: req.session.userId });
        res.json(timetables);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save settings
app.post('/api/settings', requireLogin, async (req, res) => {
    try {
        await Setting.findOneAndUpdate(
            { userId: req.session.userId },
            req.body,
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get settings
app.get('/api/settings', requireLogin, async (req, res) => {
    try {
        let settings = await Setting.findOne({ userId: req.session.userId });
        if (!settings) {
            settings = new Setting({ userId: req.session.userId });
            await settings.save();
        }
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ACCOUNT DELETION ====================
app.delete('/api/delete-account', requireLogin, async (req, res) => {
    console.log('🗑️ DELETE request received for account deletion');
    
    try {
        const userId = req.session.userId;
        console.log(`User ID to delete: ${userId}`);
        
        if (!userId) {
            console.log('❌ No user ID in session');
            return res.status(401).json({ error: 'Not authenticated' });
        }
        
        const user = await User.findById(userId);
        if (!user) {
            console.log('❌ User not found');
            return res.status(404).json({ error: 'User not found' });
        }
        
        console.log(`Deleting account for: ${user.email}`);
        
        // Delete timetable entries
        const timetableResult = await Timetable.deleteMany({ userId: userId });
        console.log(`✅ Deleted ${timetableResult.deletedCount} timetable entries`);
        
        // Delete settings
        const settingsResult = await Setting.deleteOne({ userId: userId });
        console.log(`✅ Deleted settings`);
        
        // Delete user
        const userResult = await User.findByIdAndDelete(userId);
        console.log(`✅ Deleted user: ${userResult.email}`);
        
        // Destroy session
        req.session.destroy((err) => {
            if (err) console.log('Session destroy error:', err);
            else console.log('✅ Session destroyed');
        });
        
        res.json({ 
            success: true, 
            message: 'Account deleted successfully',
            deleted: {
                user: userResult.email,
                timetables: timetableResult.deletedCount
            }
        });
        
    } catch (error) {
        console.error('❌ Account deletion error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== TEST EMAIL ENDPOINT ====================
app.get('/test-email', async (req, res) => {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: '✅ Test Email from Classroom Notifier',
            html: '<h2>Test Successful! 🎉</h2><p>Your email configuration is working.</p>'
        };
        
        const info = await transporter.sendMail(mailOptions);
        res.json({ success: true, messageId: info.messageId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== NOTIFICATION FUNCTION ====================
async function sendEmailNotification(userId, subject, message, details) {
    try {
        const user = await User.findById(userId);
        if (!user) return;
        
        const settings = await Setting.findOne({ userId });
        if (!settings || !settings.emailEnabled) return;
        
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: subject,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                    <h2 style="color: #1a73e8; text-align: center;">📚 Classroom Notifier</h2>
                    <p>Hello <strong>${user.name}</strong>,</p>
                    <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        ${message}
                    </div>
                    <hr>
                    <p style="color: #666; font-size: 12px; text-align: center;">
                        <a href="http://localhost:3000/settings.html">Change notification settings</a>
                    </p>
                </div>
            `
        };
        
        await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent to ${user.email}`);
    } catch (error) {
        console.error('❌ Email error:', error.message);
    }
}

// ==================== CRON JOB ====================
cron.schedule('* * * * *', async () => {
    try {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const currentDay = days[now.getDay()];
        
        const allTimetables = await Timetable.find({ day: currentDay });
        
        for (const timetable of allTimetables) {
            const slots = timetable.slots || [];
            const settings = await Setting.findOne({ userId: timetable.userId });
            
            if (!settings || !settings.emailEnabled) continue;
            
            const dayKey = currentDay.toLowerCase();
            if (!settings.activeDays[dayKey]) continue;
            
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                
                // Check for upcoming class reminder
                const [slotHour, slotMin] = slot.startTime.split(':').map(Number);
                const classStartTime = new Date(now);
                classStartTime.setHours(slotHour, slotMin, 0);
                const minutesUntilClass = Math.round((classStartTime - now) / 60000);
                
                if (minutesUntilClass === settings.reminderTime && minutesUntilClass > 0) {
                    const message = `
                        <h2 style="color: #667eea;">🔔 Class Reminder</h2>
                        <p><strong>📚 Subject:</strong> ${slot.subject}</p>
                        <p><strong>👨‍🏫 Faculty:</strong> ${slot.faculty}</p>
                        <p><strong>🏢 Building:</strong> ${slot.building}</p>
                        <p><strong>🚪 Room:</strong> ${slot.roomNo}</p>
                        <p><strong>⏰ Time:</strong> ${slot.startTime}</p>
                        <p><strong>🕐 Starts in:</strong> ${settings.reminderTime} minutes</p>
                    `;
                    await sendEmailNotification(timetable.userId, '🔔 Upcoming Class Reminder', message, slot);
                }
                
                // Check for room change when class ends
                if (slot.endTime === currentTime && i + 1 < slots.length) {
                    const nextSlot = slots[i + 1];
                    if (slot.roomNo !== nextSlot.roomNo) {
                        const message = `
                            <h2 style="color: #e53e3e;">🏃 Room Change Alert!</h2>
                            <p>Your next class is in a different room!</p>
                            <p><strong>📚 Next Class:</strong> ${nextSlot.subject}</p>
                            <p><strong>📍 Move from:</strong> ${slot.roomNo}</p>
                            <p><strong>🎯 To:</strong> ${nextSlot.roomNo}</p>
                            <p><strong>⏰ Time:</strong> ${nextSlot.startTime}</p>
                        `;
                        await sendEmailNotification(timetable.userId, '🏃 Room Change Notification', message, nextSlot);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Cron job error:', error);
    }
});

// ==================== SERVE HTML PAGES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/timetable.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'timetable.html'));
});

app.get('/settings.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
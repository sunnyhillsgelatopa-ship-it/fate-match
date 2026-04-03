const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// VAPID keys for push notifications
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails('mailto:admin@fatematch.com', vapidKeys.publicKey, vapidKeys.privateKey);

// State
const users = new Map();
const chatRooms = new Map();
const allChatLogs = [];
let statsData = { users: 0, chats: 0, messages: 0, connects: 0 };

// Get VAPID public key
app.get('/api/vapid-key', (req, res) => res.json({ key: vapidKeys.publicKey }));

// Register
app.post('/api/register', (req, res) => {
  const { gender, nickname, description, userId, contacts, interests, avatar } = req.body;
  if (!gender || !nickname || !description) return res.status(400).json({ error: 'missing' });
  if (userId && users.has(userId)) return res.status(409).json({ error: 'exists' });
  const id = userId || crypto.randomUUID();
  users.set(id, { id, gender, nickname, description, contacts: contacts || {}, interests: interests || [], avatar: avatar || '', online: false, socketId: null, pushSub: null, didis: [], roomId: null, createdAt: Date.now() });
  statsData.users++;
  res.json({ userId: id });
});

// Get users for bubbles
app.get('/api/users', (req, res) => {
  const myId = req.query.userId;
  const list = [];
  users.forEach((u, id) => { if (id !== myId) list.push({ id: u.id, gender: u.gender, nickname: u.nickname, description: u.description, interests: u.interests || [], avatar: u.avatar || '', online: u.online }); });
  res.json(list);
});

// Update profile
app.put('/api/update-profile', (req, res) => {
  const { userId, nickname, description, contacts, interests } = req.body;
  const u = users.get(userId);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (nickname !== undefined) u.nickname = nickname;
  if (description !== undefined) u.description = description;
  if (contacts !== undefined) u.contacts = contacts;
  if (interests !== undefined) u.interests = interests;
  if (req.body.avatar !== undefined) u.avatar = req.body.avatar;
  res.json({ ok: true });
});

// Send didi
app.post('/api/didi', (req, res) => {
  const { fromId, toId } = req.body;
  const from = users.get(fromId), to = users.get(toId);
  if (!from || !to) return res.status(404).json({ error: 'not found' });
  const didi = { fromId, fromNickname: from.nickname, fromGender: from.gender, fromDesc: from.description, timestamp: Date.now() };
  to.didis.push(didi);
  // Realtime notify if online
  if (to.online && to.socketId) {
    const ts = io.sockets.sockets.get(to.socketId);
    if (ts) ts.emit('didi_received', didi);
  }
  // Push notification
  if (to.pushSub) {
    webpush.sendNotification(to.pushSub, JSON.stringify({ title: '💕 有人滴滴你了！', body: from.nickname + ' 想和你聊天，快来看看！', url: '/' })).catch(() => {});
  }
  res.json({ success: true });
});

// Save push subscription
app.post('/api/push-subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  const u = users.get(userId);
  if (u) { u.pushSub = subscription; res.json({ ok: true }); }
  else res.status(404).json({ error: 'not found' });
});

// Check registration
app.get('/api/check', (req, res) => {
  const u = users.get(req.query.userId);
  res.json(u ? { registered: true, nickname: u.nickname, gender: u.gender } : { registered: false });
});

// Get my didis
app.get('/api/my-didis', (req, res) => {
  const u = users.get(req.query.userId);
  if (!u) return res.json([]);
  res.json(u.didis);
});

// Admin endpoints
app.get('/admin/data', (req, res) => {
  if (req.query.pwd !== 'admin123') return res.status(403).json({ error: 'wrong' });
  const ul = [];
  users.forEach(u => ul.push({ id: u.id, nickname: u.nickname, gender: u.gender, description: u.description, contacts: u.contacts, online: u.online, didis: u.didis.length, createdAt: u.createdAt }));
  res.json({ stats: statsData, users: ul, logs: allChatLogs.slice(-100).reverse(), online: [...users.values()].filter(u => u.online).length });
});

app.get('/admin/users', (req, res) => {
  if (req.query.pwd !== 'admin123') return res.status(403).json({ error: 'wrong' });
  const ul = [];
  users.forEach(u => ul.push({ id: u.id, nickname: u.nickname, gender: u.gender, description: u.description, contacts: u.contacts, online: u.online, didis: u.didis.length, createdAt: u.createdAt }));
  res.json(ul);
});

app.delete('/admin/user/:id', (req, res) => {
  if (req.query.pwd !== 'admin123') return res.status(403).json({ error: 'wrong' });
  users.delete(req.params.id);
  statsData.users--;
  res.json({ ok: true });
});

app.put('/admin/user/:id', (req, res) => {
  if (req.query.pwd !== 'admin123') return res.status(403).json({ error: 'wrong' });
  const u = users.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { nickname, gender, description, contacts } = req.body;
  if (nickname !== undefined) u.nickname = nickname;
  if (gender !== undefined) u.gender = gender;
  if (description !== undefined) u.description = description;
  if (contacts !== undefined) u.contacts = contacts;
  res.json({ ok: true });
});

// Serve admin page
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Socket.IO
io.on('connection', (socket) => {
  let myUserId = null;

  socket.on('go_online', ({ userId }) => {
    const u = users.get(userId);
    if (!u) return;
    u.online = true; u.socketId = socket.id; myUserId = userId;
    if (u.didis.length > 0) socket.emit('pending_didis', u.didis);
    // Broadcast online status
    io.emit('user_status', { userId, online: true });
  });

  // Accept didi -> try start chat
  socket.on('accept_didi', ({ fromId }) => {
    const me = users.get(myUserId), from = users.get(fromId);
    if (!me || !from) return;
    me.didis = me.didis.filter(d => d.fromId !== fromId);
    if (from.online && from.socketId) {
      const fs = io.sockets.sockets.get(from.socketId);
      if (fs) {
        // Notify sender: target accepted, do you want to chat?
        fs.emit('didi_accepted', { userId: myUserId, nickname: me.nickname, gender: me.gender });
        socket.emit('waiting_for_sender', { nickname: from.nickname });
      }
    } else {
      socket.emit('partner_offline_msg', { nickname: from.nickname });
      // Push notify sender
      if (from.pushSub) {
        webpush.sendNotification(from.pushSub, JSON.stringify({ title: '💕 ' + me.nickname + ' 接受了你的邀请！', body: '快来聊天吧！', url: '/' })).catch(() => {});
      }
    }
  });

  // Sender confirms chat
  socket.on('confirm_chat', ({ targetId }) => {
    const me = users.get(myUserId), target = users.get(targetId);
    if (!me || !target || !target.online || !target.socketId) return;
    const ts = io.sockets.sockets.get(target.socketId);
    if (!ts) return;

    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    socket.join(roomId); ts.join(roomId);
    const startTime = Date.now(), DUR = 5 * 60 * 1000;
    const wt = setTimeout(() => io.to(roomId).emit('time_warning'), 4 * 60 * 1000);
    const et = setTimeout(() => { io.to(roomId).emit('chat_ended'); const r = chatRooms.get(roomId); if (r) r.ended = true; }, DUR);
    chatRooms.set(roomId, { users: [myUserId, targetId], warningTimer: wt, endTimer: et, startTime, ended: false, log: { id: roomId, date: new Date().toISOString(), user1: { nickname: me.nickname, gender: me.gender }, user2: { nickname: target.nickname, gender: target.gender }, messages: [], connected: false } });
    me.roomId = roomId; target.roomId = roomId; statsData.chats++;
    socket.emit('chat_started', { roomId, partner: { nickname: target.nickname, gender: target.gender }, startTime });
    ts.emit('chat_started', { roomId, partner: { nickname: me.nickname, gender: me.gender }, startTime });
  });

  // Reject didi acceptance
  socket.on('reject_chat', ({ targetId }) => {
    const target = users.get(targetId);
    if (target && target.online && target.socketId) {
      const ts = io.sockets.sockets.get(target.socketId);
      if (ts) ts.emit('chat_rejected', { nickname: users.get(myUserId)?.nickname });
    }
  });

  socket.on('chat_message', (data) => {
    const me = users.get(myUserId);
    if (!me || !me.roomId) return;
    const room = chatRooms.get(me.roomId);
    if (!room || room.ended) return;
    statsData.messages++;
    room.log.messages.push({ sender: me.nickname, text: data.message, time: new Date().toLocaleTimeString() });
    socket.to(me.roomId).emit('chat_message', { nickname: me.nickname, message: data.message });
  });

  socket.on('request_connect', () => {
    const me = users.get(myUserId);
    if (!me || !me.roomId) return;
    const room = chatRooms.get(me.roomId);
    if (!room) return;
    const pid = room.users.find(id => id !== myUserId);
    const p = users.get(pid);
    if (p && p.socketId) { const ps = io.sockets.sockets.get(p.socketId); if (ps) { ps.emit('connect_request', { from: me.nickname, fromId: myUserId }); socket.emit('request_sent'); } }
  });

  socket.on('respond_connect', ({ accepted, requesterId }) => {
    const rs = io.sockets.sockets.get(users.get(requesterId)?.socketId);
    const me = users.get(myUserId);
    if (accepted && rs && me) {
      const ri = users.get(requesterId);
      statsData.connects++;
      const room = chatRooms.get(me.roomId); if (room) room.log.connected = true;
      rs.emit('connect_accepted', { nickname: me.nickname, contacts: me.contacts });
      socket.emit('connect_accepted', { nickname: ri.nickname, contacts: ri.contacts });
    } else if (rs) rs.emit('connect_rejected');
  });

  socket.on('leave_chat', () => cleanupChat(myUserId));
  socket.on('disconnect', () => {
    if (myUserId) {
      const u = users.get(myUserId);
      if (u) { u.online = false; u.socketId = null; }
      cleanupChat(myUserId);
      io.emit('user_status', { userId: myUserId, online: false });
    }
  });
});

function cleanupChat(userId) {
  const u = users.get(userId);
  if (!u || !u.roomId) return;
  const room = chatRooms.get(u.roomId);
  if (room) {
    clearTimeout(room.warningTimer); clearTimeout(room.endTimer);
    allChatLogs.push(room.log);
    const pid = room.users.find(id => id !== userId);
    const p = users.get(pid);
    if (p) { p.roomId = null; if (p.socketId) { const ps = io.sockets.sockets.get(p.socketId); if (ps) ps.emit('partner_left'); } }
    chatRooms.delete(u.roomId);
  }
  u.roomId = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port ' + PORT));

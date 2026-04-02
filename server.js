const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const waitingUsers = { male: [], female: [] };
const activeRooms = new Map();
const userInfo = new Map();
const allChatLogs = [];
let statsData = { users: 0, chats: 0, messages: 0, connects: 0 };

function generateRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function tryMatch(socket) {
  const info = userInfo.get(socket.id);
  if (!info) return;
  const myGender = info.gender;
  const targetGender = myGender === 'male' ? 'female' : 'male';
  let matchQueue = waitingUsers[targetGender];
  if (matchQueue.length === 0) matchQueue = waitingUsers[myGender].filter(id => id !== socket.id);
  if (matchQueue.length > 0) {
    const partnerId = matchQueue.shift();
    waitingUsers.male = waitingUsers.male.filter(id => id !== partnerId && id !== socket.id);
    waitingUsers.female = waitingUsers.female.filter(id => id !== partnerId && id !== socket.id);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) { waitingUsers[myGender].push(socket.id); return; }
    const roomId = generateRoomId();
    socket.join(roomId); partnerSocket.join(roomId);
    const partnerInfo = userInfo.get(partnerId);
    info.roomId = roomId; partnerInfo.roomId = roomId;
    const startTime = Date.now();
    const warningTimer = setTimeout(() => { io.to(roomId).emit('time_warning', { remainingSeconds: 60 }); }, 4 * 60 * 1000);
    const endTimer = setTimeout(() => { io.to(roomId).emit('chat_ended'); const room = activeRooms.get(roomId); if (room) room.ended = true; }, 5 * 60 * 1000);
    const roomData = { users: [socket.id, partnerId], warningTimer, endTimer, startTime, ended: false,
      log: { id: roomId, date: new Date().toISOString(),
        user1: { nickname: info.nickname, gender: info.gender, contact: info.contact },
        user2: { nickname: partnerInfo.nickname, gender: partnerInfo.gender, contact: partnerInfo.contact },
        messages: [], connected: false }
    };
    activeRooms.set(roomId, roomData); statsData.chats++;
    socket.emit('matched', { roomId, partner: { nickname: partnerInfo.nickname, gender: partnerInfo.gender }, startTime });
    partnerSocket.emit('matched', { roomId, partner: { nickname: info.nickname, gender: info.gender }, startTime });
  } else { waitingUsers[myGender].push(socket.id); socket.emit('waiting'); }
}

app.get('/admin/data', (req, res) => {
  if (req.query.pwd !== 'admin123') return res.status(403).json({ error: 'wrong password' });
  res.json({ stats: statsData, logs: allChatLogs.slice(-100).reverse(), online: userInfo.size, waiting: waitingUsers.male.length + waitingUsers.female.length });
});

io.on('connection', (socket) => {
  socket.on('register', (data) => { userInfo.set(socket.id, { gender: data.gender, contact: data.contact, nickname: data.nickname, roomId: null }); statsData.users++; tryMatch(socket); });
  socket.on('chat_message', (data) => { const info = userInfo.get(socket.id); if (!info || !info.roomId) return; const room = activeRooms.get(info.roomId); if (!room || room.ended) return; statsData.messages++; room.log.messages.push({ sender: info.nickname, text: data.message, time: new Date().toLocaleTimeString() }); socket.to(info.roomId).emit('chat_message', { nickname: info.nickname, message: data.message, timestamp: Date.now() }); });
  socket.on('request_connect', () => { const info = userInfo.get(socket.id); if (!info || !info.roomId) return; const room = activeRooms.get(info.roomId); if (!room) return; const partnerId = room.users.find(id => id !== socket.id); if (!partnerId) return; const ps = io.sockets.sockets.get(partnerId); if (ps) { ps.emit('connect_request', { from: info.nickname, fromId: socket.id }); socket.emit('request_sent'); } });
  socket.on('respond_connect', (data) => { const rs = io.sockets.sockets.get(data.requesterId); const info = userInfo.get(socket.id); if (data.accepted && rs) { const ri = userInfo.get(data.requesterId); if (ri && info) { statsData.connects++; const room = activeRooms.get(info.roomId); if (room) room.log.connected = true; rs.emit('connect_accepted', { nickname: info.nickname, contact: info.contact }); socket.emit('connect_accepted', { nickname: ri.nickname, contact: ri.contact }); } } else if (rs) { rs.emit('connect_rejected'); } });
  socket.on('leave_chat', () => cleanupUser(socket));
  socket.on('disconnect', () => cleanupUser(socket));
});

function cleanupUser(socket) {
  const info = userInfo.get(socket.id); if (!info) return;
  waitingUsers.male = waitingUsers.male.filter(id => id !== socket.id);
  waitingUsers.female = waitingUsers.female.filter(id => id !== socket.id);
  if (info.roomId) { const room = activeRooms.get(info.roomId); if (room) { clearTimeout(room.warningTimer); clearTimeout(room.endTimer); allChatLogs.push(room.log); const partnerId = room.users.find(id => id !== socket.id); if (partnerId) { const ps = io.sockets.sockets.get(partnerId); if (ps) { ps.emit('partner_left'); const pi = userInfo.get(partnerId); if (pi) pi.roomId = null; } } activeRooms.delete(info.roomId); } }
  userInfo.delete(socket.id);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));

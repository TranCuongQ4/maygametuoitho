// CẤU HÌNH KẾT NỐI FIREBASE CỦA TRẦN CƯỜNG
const firebaseConfig = {
    databaseURL: "https://cuongdata-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Khởi tạo Firebase
if (firebase.apps.length === 0) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

let peerConnection = null;
let dataChannel = null;
let isHost = false;
let currentRoomId = null;
let isOnlineMode = false;
let myRole = ""; // "host" hoặc "guest"

// Hàng đợi lưu tạm thời các ICE Candidate nếu nó đến quá sớm khi chưa setRemoteDescription
let pendingCandidates = [];

// Cấu hình STUN server miễn phí của Google để tìm kiếm địa chỉ IP WAN P2P
const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ]
};

// Mảng bảng phím mặc định của EmulatorJS dành cho Player 1 và Player 2 để chúng ta map tín hiệu mạng
const P1_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "x", "Shift", "Enter"];
const P2_KEYS = ["w", "s", "a", "d", "i", "o", "c", "v"];

// --- THEO DÕI TRẠNG THÁI MẠNG ĐỂ TỰ ĐỘNG KHÔI PHỤC KẾT NỐI ---
db.ref(".info/connected").on("value", (snapshot) => {
    if (snapshot.val() === false) {
        console.log("⚠️ Phát hiện mất kết nối mạng hoặc Firebase đang tải lại...");
        const statusEl = document.getElementById("connection-status");
        if (statusEl && isOnlineMode) {
            statusEl.textContent = "⚠️ Mạng chập chờn, đang tự động kết nối lại...";
            statusEl.style.color = "#ff3366";
        }
    } else {
        console.log("✅ Kết nối Firebase hoạt động ổn định.");
        const statusEl = document.getElementById("connection-status");
        if (statusEl && isOnlineMode && isHost && currentRoomId) {
            statusEl.textContent = "⌛ Đang đợi bạn vào phòng...";
            statusEl.style.color = "#ffcc00";
        }
    }
});

// --- KIỂM TRA ĐƯỜNG DẪN URL XEM CÓ PHẢI LÀ KHÁCH CLICK VÀO LINK KHÔNG ---
window.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('room')) {
        currentRoomId = urlParams.get('room');
        const gameParam = urlParams.get('game') || "roms/dino.zip";
        
        isOnlineMode = true;
        isHost = false;
        myRole = "guest";
        
        // Hiển thị modal kết nối phía khách
        const modal = document.getElementById("online-modal");
        if(modal) modal.style.display = "flex";
        
        const title = document.getElementById("online-title");
        if(title) title.textContent = "KẾT NỐI CHƠI ONLINE";
        
        const body = document.getElementById("online-body");
        if(body) body.innerHTML = `<p style='color:#00ffcc;'>🎮 Đang tham gia phòng: <b>${currentRoomId}</b></p><p id='join-status'>⚡ Đang thiết lập kết nối mạng P2P...</p>`;
        
        // Tiến hành chạy hàm kết nối của khách vào phòng
        joinOnlineRoom(currentRoomId, gameParam);
    }
});

// --- CHỨC NĂNG 1: TẠO PHÒNG VÀ TỰ ĐỘNG DỌN DẸP FIREBASE QUÁ 12 GIỜ (DÀNH CHO HOST) ---
function createOnlineRoom() {
    isOnlineMode = true;
    isHost = true;
    myRole = "host";
    pendingCandidates = []; // Reset hàng đợi candidates
    
    if (peerConnection) {
        try { peerConnection.close(); } catch(e){}
    }
    
    // --- BỘ QUẢN LÝ RESET DỮ LIỆU CHỐNG TRÀN FIREBASE (12 TIẾNG) ---
    const now = Date.now();
    const twelveHours = 12 * 60 * 60 * 1000; // 12 giờ tính bằng mili-giây
    
    db.ref("rooms").once("value", (snapshot) => {
        const rooms = snapshot.val();
        if (rooms) {
            Object.keys(rooms).forEach(roomId => {
                const room = rooms[roomId];
                // Nếu phòng không có mốc thời gian hoặc đã tồn tại quá 12 tiếng, tự động xóa sạch
                if (!room.createdAt || (now - room.createdAt) > twelveHours) {
                    db.ref("rooms/" + roomId).remove()
                        .then(() => console.log(`🗑️ Đã xóa dọn dẹp phòng cũ tránh tràn Firebase: ${roomId}`))
                        .catch(e => console.log("Lỗi dọn dẹp:", e));
                }
            });
        }
    });

    // Tạo ID phòng ngẫu nhiên gồm 6 chữ số
    currentRoomId = Math.floor(100000 + Math.random() * 900000);
    const roomRef = db.ref("rooms/" + currentRoomId);
    
    // Sinh đường dẫn phòng gửi cho bạn bè
    const roomLink = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}&game=${encodeURIComponent(currentSelectedRomUrl)}`;
    document.getElementById("room-link-input").value = roomLink;
    document.getElementById("room-info-section").style.display = "block";
    
    // Khởi tạo thông tin phòng lên Firebase kèm mốc thời gian thực để phục vụ bộ quét xóa
    roomRef.set({
        gameUrl: currentSelectedRomUrl,
        gameName: currentSelectedRomName,
        status: "waiting",
        createdAt: firebase.database.ServerValue.TIMESTAMP
    });

    // Lắng nghe xem có Khách kết nối và gửi câu trả lời mạng (Answer) lên Firebase không
    roomRef.child("answer").on("value", async (snapshot) => {
        const answer = snapshot.val();
        if (answer && peerConnection && peerConnection.signalingState === "have-local-offer") {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                document.getElementById("connection-status").textContent = "🟢 Đã kết nối thành công! Trận đấu bắt đầu...";
                document.getElementById("connection-status").style.color = "#00ffcc";
                
                processPendingCandidates();

                // Đợi 1 giây cho đường ống mạng ổn định rồi kích hoạt màn hình game
                setTimeout(() => {
                    if (typeof closeOnlineModal === "function") closeOnlineModal();
                    startGame(currentSelectedRomUrl, currentSelectedRomName);
                }, 1000);
            } catch(err) {
                console.log("Lỗi đồng bộ cấu hình bắt tay mạng:", err);
            }
        }
    });

    // Lắng nghe gói định vị ICE mạng từ khách gửi lên
    roomRef.child("guestCandidates").on("child_added", (snapshot) => {
        const candidate = snapshot.val();
        if (candidate && peerConnection) {
            if (!peerConnection.remoteDescription) {
                pendingCandidates.push(candidate);
            } else {
                peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.log("Lỗi nạp định vị mạng:", e));
            }
        }
    });

    // Khởi tạo quy trình WebRTC Web Connection
    setupWebRTC(roomRef);
}

// Hàm giải phóng hàng đợi candidate
function processPendingCandidates() {
    if (peerConnection && peerConnection.remoteDescription) {
        while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.log("Lỗi giải phóng Candidate:", e));
        }
    }
}

// Hàm sao chép link phòng nhanh
function copyRoomLink() {
    const copyText = document.getElementById("room-link-input");
    copyText.select();
    copyText.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(copyText.value);
    alert("Đã copy link phòng! Hãy gửi link này cho bạn chơi qua Zalo nhé.");
}

// --- CHỨC NĂNG 2: THAM GIA PHÒNG VÀ TỰ ĐỘNG RECONNECT (DÀNH CHO GUEST) ---
async function joinOnlineRoom(roomId, gameUrl) {
    const roomRef = db.ref("rooms/" + roomId);
    pendingCandidates = []; // Reset hàng đợi candidates
    
    if (peerConnection) {
        try { peerConnection.close(); } catch(e){}
    }
    
    roomRef.once("value", async (snapshot) => {
        const roomData = snapshot.val();
        if (!roomData) {
            alert("Phòng chơi không tồn tại hoặc đã bị hủy do hết hạn!");
            window.location.href = window.location.pathname;
            return;
        }
        
        currentSelectedRomUrl = roomData.gameUrl;
        currentSelectedRomName = roomData.gameName;

        peerConnection = new RTCPeerConnection(rtcConfig);
        
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannelEvents();
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                const candidateObj = JSON.parse(JSON.stringify(event.candidate));
                roomRef.child("guestCandidates").push(candidateObj);
            }
        };

        const offerSnapshot = await roomRef.child("offer").once("value");
        const offer = offerSnapshot.val();
        if (!offer) {
            const joinStatusEl = document.getElementById("join-status");
            if(joinStatusEl) joinStatusEl.textContent = "❌ Lỗi mạng: Chủ phòng chưa khởi tạo mã bắt tay!";
            return;
        }
        
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            const answerObj = JSON.parse(JSON.stringify(answer));
            await roomRef.update({ answer: answerObj, status: "connected" });

            processPendingCandidates();
        } catch(err) {
            console.log("Lỗi thiết lập liên kết khách:", err);
        }

        roomRef.child("hostCandidates").on("child_added", (snapshot) => {
            const candidate = snapshot.val();
            if (candidate && peerConnection) {
                if (!peerConnection.remoteDescription) {
                    pendingCandidates.push(candidate);
                } else {
                    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.log("Lỗi nạp định vị mạng:", e));
                }
            }
        });
    });
}

// --- CHỨC NĂNG 3: KHỞI TẠO ĐƯỜNG TRUYỀN WEBRTC ---
async function setupWebRTC(roomRef) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    
    dataChannel = peerConnection.createDataChannel("gameControls", { ordered: false }); 
    setupDataChannelEvents();

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            const candidateObj = JSON.parse(JSON.stringify(event.candidate));
            roomRef.child("hostCandidates").push(candidateObj);
        }
    };

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        const offerObj = JSON.parse(JSON.stringify(offer));
        await roomRef.update({ offer: offerObj });
    } catch(err) {
        console.log("Lỗi tạo mã khởi tạo mạng:", err);
    }
}

// Cấu hình sự kiện mở đóng của đường truyền data channel
function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        console.log("Đường truyền WebRTC Đã Mở!");
        
        // KÍCH HOẠT ĐỒNG BỘ PHÍM NGAY KHI ĐƯỜNG TRUYỀN MỞ THÀNH CÔNG
        setupOnlineKeySync();

        if (!isHost) {
            const joinStatusEl = document.getElementById("join-status");
            if(joinStatusEl) joinStatusEl.textContent = "🟢 Đang vào game cùng chủ phòng...";
            setTimeout(() => {
                if (typeof closeOnlineModal === "function") closeOnlineModal();
                startGame(currentSelectedRomUrl, currentSelectedRomName);
            }, 1000);
        }
    };
    
    dataChannel.onclose = () => {
        console.log("Mất kết nối mạng P2P!");
        if (!isHost && isOnlineMode && currentRoomId) {
            console.log("🔄 Khách bị rớt mạng, tiến hành tự động kết nối lại vào phòng...");
            setTimeout(() => {
                joinOnlineRoom(currentRoomId, currentSelectedRomUrl);
            }, 2000);
        } else {
            alert("Kết nối mạng bị gián đoạn hoặc phòng chơi kết thúc!");
            forceCloseGame();
        }
    };

    // NHẬN TÍN HIỆU PHÍM BẤM TỪ MÁY ĐỐI THỦ GỬI SANG VÀ TIÊM VÀO EMULATOR
    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "keyup" || msg.type === "keydown") {
            simulateEmulatorKeyEvent(msg.type, msg.key, msg.player);
        }
    };
}

// --- CHỨC NĂNG 4: BỘ ĐIỀU PHỐI ĐÁNH CHẶN VÀ ĐỒNG BỘ PHÍM BÀN PHÍM ---
function setupOnlineKeySync() {
    if (!isOnlineMode) return;
    console.log("⌨️ Hệ thống đánh chặn phím Online đã được kích hoạt thành công!");

    // Sử dụng bộ bắt sự kiện ở tầng cao nhất (capture mode: true) để chia tách luồng phím cơ học
    window.addEventListener("keydown", (e) => handleKeyEvent(e, "keydown"), true);
    window.addEventListener("keyup", (e) => handleKeyEvent(e, "keyup"), true);
}

function handleKeyEvent(event, type) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;

    if (isHost) {
        // Nếu là Host (Player 1) thì tuyệt đối chặn không cho phím Player 2 (w,a,s,d...) tác động lên máy mình
        if (P2_KEYS.includes(pressedKey.toLowerCase())) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        
        // Host ấn phím Player 1 -> Gửi tín hiệu sang máy Khách để điều khiển P1 bên đó
        if (P1_KEYS.includes(pressedKey)) {
            dataChannel.send(JSON.stringify({
                type: type,
                key: pressedKey,
                player: 1
            }));
        }
    } else {
        // Nếu là Khách (Player 2)
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            // Chặn đứng không cho phím mặc định (Mũi tên, Z, X...) kích hoạt Player 1 của máy Khách
            event.preventDefault();
            event.stopPropagation();
            
            // Map phím của Khách thành phím P2 hệ thống (w, a, s, d...)
            let mappedP2Key = P2_KEYS[keyIndex];
            
            // Gửi phím đã map sang cho máy Host nhận dạng điều khiển Player 2
            dataChannel.send(JSON.stringify({
                type: type,
                key: mappedP2Key,
                player: 2
            }));
            
            // Đồng thời tự giả lập tiêm phím P2 vào màn hình game của chính mình
            simulateEmulatorKeyEvent(type, mappedP2Key, 2);
        }
    }
}

// Hàm giả lập tiêm phím trực tiếp vào đối tượng xử lý EmulatorJS của trình duyệt
function simulateEmulatorKeyEvent(type, keyName, targetPlayer) {
    const e = new KeyboardEvent(type, {
        key: keyName,
        bubbles: true,
        cancelable: true
    });
    
    const emulatorEl = document.querySelector(window.EJS_player || "#emulator");
    if (emulatorEl) {
        emulatorEl.dispatchEvent(e);
    }
}
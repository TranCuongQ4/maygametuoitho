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
let pendingCandidates = [];

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ]
};

// BẢNG ÁNH XẠ NÚT BẤM CHUẨN LIBRETRO/SNES9X
const P1_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "x", "Shift", "Enter"];
const P2_KEYS = ["w", "s", "a", "d", "i", "o", "c", "v"];

const KEY_TO_BUTTON_ID = {
    "ArrowUp": 0, "ArrowDown": 1, "ArrowLeft": 2, "ArrowRight": 3, "z": 8, "x": 9, "Shift": 11, "Enter": 10,
    "w": 0, "s": 1, "a": 2, "d": 3, "i": 8, "o": 9, "c": 11, "v": 10
};

// Cấu hình lõi EmulatorJS nhận diện 2 người chơi độc lập
window.EJS_players = 2;
window.EJS_maxPlayers = 2;
window.EJS_gamepad = true;

window.EJS_onGameStart = function() {
    console.log("🎮 Lõi giả lập snes9x khởi động - Tiến hành ép cấu hình 2 tay cầm song song...");
    if (window.EJS_emulator && window.EJS_emulator.api) {
        try {
            if (typeof window.EJS_emulator.api.setControllerPortDevice === "function") {
                window.EJS_emulator.api.setControllerPortDevice(0, 1); // Port 1 -> Tay cầm tiêu chuẩn
                window.EJS_emulator.api.setControllerPortDevice(1, 1); // Port 2 -> Tay cầm tiêu chuẩn
                console.log("✅ Kích hoạt cổng phần cứng snes9x thành công.");
            }
        } catch (err) {
            console.log("Lỗi cấu hình API:", err);
        }
    }
};

// THEO DÕI ĐƯỜNG DẪN URL ĐỂ PHÂN LUỒNG MÁY 2 (GUEST) VÀO SAU
window.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('room')) {
        currentRoomId = urlParams.get('room');
        const gameParam = urlParams.get('game') || "roms/dino.zip";
        
        isOnlineMode = true;
        isHost = false;
        myRole = "guest";
        
        const modal = document.getElementById("online-modal");
        if(modal) modal.style.display = "flex";
        
        const body = document.getElementById("online-body");
        if(body) body.innerHTML = `<p style='color:#00ffcc;'>🎮 Bạn là <b>Máy 2 (Guest)</b>. Đang đồng bộ vào trận đấu...</p>`;
        
        setTimeout(() => {
            if (typeof closeOnlineModal === "function") closeOnlineModal();
            startGame(gameParam, "Game Online");
        }, 500);

        joinOnlineRoom(currentRoomId, gameParam);
    }
});

// --- CHỨC NĂNG 1: TẠO PHÒNG (GIỮ NGUYÊN GIAO DIỆN ĐỂ BẤM COPY) ---
function createOnlineRoom() {
    isOnlineMode = true;
    isHost = true;
    myRole = "host";
    pendingCandidates = []; 
    
    if (peerConnection) { try { peerConnection.close(); } catch(e){} }
    
    // Tự động dọn dẹp các phòng cũ bị bỏ quên quá 12 tiếng
    const now = Date.now();
    db.ref("rooms").once("value", (snapshot) => {
        const rooms = snapshot.val();
        if (rooms) {
            Object.keys(rooms).forEach(id => {
                if (!rooms[id].createdAt || (now - rooms[id].createdAt) > 12 * 60 * 60 * 1000) {
                    db.ref("rooms/" + id).remove();
                }
            });
        }
    });

    currentRoomId = Math.floor(100000 + Math.random() * 900000);
    const roomRef = db.ref("rooms/" + currentRoomId);
    
    // Tạo link kết nối và hiển thị lên giao diện cho anh copy
    const roomLink = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}&game=${encodeURIComponent(currentSelectedRomUrl)}`;
    document.getElementById("room-link-input").value = roomLink;
    document.getElementById("room-info-section").style.display = "block";
    
    roomRef.set({
        gameUrl: currentSelectedRomUrl,
        gameName: currentSelectedRomName,
        status: "waiting",
        createdAt: firebase.database.ServerValue.TIMESTAMP
    });

    // KHÔNG gọi hàm startGame() ở đây nữa để tránh việc nhảy vào game che khuất mất link của anh!

    // Lắng nghe tín hiệu từ Máy 2 khi họ click vào link sau đó
    roomRef.child("answer").on("value", async (snapshot) => {
        const answer = snapshot.val();
        if (answer && peerConnection && peerConnection.signalingState === "have-local-offer") {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log("🟢 Máy 2 đã kết nối vào phòng thành công!");
                processPendingCandidates();
            } catch(err) {
                console.log("Lỗi bắt tay mạng:", err);
            }
        }
    });

    roomRef.child("guestCandidates").on("child_added", (snapshot) => {
        const candidate = snapshot.val();
        if (candidate && peerConnection) {
            if (!peerConnection.remoteDescription) { pendingCandidates.push(candidate); } 
            else { peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {}); }
        }
    });

    setupWebRTC(roomRef);
}

// 🔥 SỬA ĐỔI QUAN TRỌNG: BẤM COPY XONG LÀ TỰ ĐỘNG KHỞI ĐỘNG VÀO GAME LUÔN!
function copyRoomLink() {
    const copyText = document.getElementById("room-link-input");
    copyText.select();
    copyText.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(copyText.value);
    
    alert("Đã sao chép link phòng! Giờ hệ thống sẽ tự động đưa bạn vào game trước.");

    // Tiến hành ẩn modal và kích hoạt vào game ngay sau khi đã có link trong bộ nhớ tạm
    if (typeof closeOnlineModal === "function") closeOnlineModal();
    
    const emulatorEl = document.querySelector("#emulator");
    if (!emulatorEl || emulatorEl.innerHTML === "") {
        console.log("🚀 Host bắt đầu tải game chạy trước...");
        startGame(currentSelectedRomUrl, currentSelectedRomName);
    }
}

function processPendingCandidates() {
    if (peerConnection && peerConnection.remoteDescription) {
        while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {});
        }
    }
}

// --- CHỨC NĂNG 2: THAM GIA PHÒNG (MÁY 2 - GUEST VÀO SAU) ---
async function joinOnlineRoom(roomId, gameUrl) {
    const roomRef = db.ref("rooms/" + roomId);
    pendingCandidates = []; 
    if (peerConnection) { try { peerConnection.close(); } catch(e){} }
    
    roomRef.once("value", async (snapshot) => {
        const roomData = snapshot.val();
        if (!roomData) return;

        peerConnection = new RTCPeerConnection(rtcConfig);
        
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannelEvents();
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                roomRef.child("guestCandidates").push(JSON.parse(JSON.stringify(event.candidate)));
            }
        };

        const offerSnapshot = await roomRef.child("offer").once("value");
        const offer = offerSnapshot.val();
        
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await roomRef.update({ answer: JSON.parse(JSON.stringify(answer)), status: "connected" });
            processPendingCandidates();
        } catch(err) {
            console.log("Lỗi cấu hình Máy 2:", err);
        }

        roomRef.child("hostCandidates").on("child_added", (snapshot) => {
            const candidate = snapshot.val();
            if (candidate && peerConnection) {
                if (!peerConnection.remoteDescription) { pendingCandidates.push(candidate); } 
                else { peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {}); }
            }
        });
    });
}

async function setupWebRTC(roomRef) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    dataChannel = peerConnection.createDataChannel("gameControls", { ordered: false }); 
    setupDataChannelEvents();

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            roomRef.child("hostCandidates").push(JSON.parse(JSON.stringify(event.candidate)));
        }
    };

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        await roomRef.update({ offer: JSON.parse(JSON.stringify(offer)) });
    } catch(err) {
        console.log("Lỗi tạo Offer:", err);
    }
}

// --- CHỨC NĂNG 3: NƯƠNG DỮ LIỆU NHAU - ĐỒNG BỘ HAI CHIỀU LIÊN TỤC ---
function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        console.log("🚀 Đường truyền WebRTC P2P song song hoạt động!");
        setupOnlineKeySync();
    };
    
    dataChannel.onclose = () => {
        console.log("⚠️ Bạn chơi bị văng, chế độ chơi đơn tự động duy trì.");
    };

    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        // Nhận lệnh nút bấm của đối phương gửi qua
        if (msg.type === "sync_keypress") {
            executeDirectGamepadInput(msg.player, msg.button, msg.value);
        }
        
        // NHẬN VÀ LÀM MƯỢT BỘ NHỚ THEO NGUYÊN LÝ NƯƠNG DỮ LIỆU CỦA ANH
        if (msg.type === "p2p_share_state") {
            if (window.EJS_emulator && window.EJS_emulator.gameManager) {
                try {
                    window.EJS_emulator.gameManager.loadState(new Uint8Array(msg.gameState));
                } catch(e){}
            }
        }
    };
}

// --- CHỨC NĂNG 4: ĐÁNH CHẶN VÀ PHÂN LUỒNG PHÍM TAY CẦM 1 & 2 ---
function setupOnlineKeySync() {
    if (!isOnlineMode) return;

    // Khóa trình gán phím mặc định lỗi thời của EmulatorJS
    const cleanLoop = setInterval(() => {
        if (window.EJS_emulator && window.EJS_emulator.gameManager && window.EJS_emulator.gameManager.handleKeyDown) {
            window.removeEventListener("keydown", window.EJS_emulator.gameManager.handleKeyDown);
            window.removeEventListener("keyup", window.EJS_emulator.gameManager.handleKeyUp);
            window.EJS_emulator.gameManager.handleKeyDown = function(e){ e.preventDefault(); };
            window.EJS_emulator.gameManager.handleKeyUp = function(e){ e.preventDefault(); };
            clearInterval(cleanLoop);
            console.log("🔥 Đã bẻ khóa và chia luồng tay cầm độc lập.");
        }
    }, 100);

    window.addEventListener("keydown", (e) => handleStrictKeyEvent(e, 1), true);
    window.addEventListener("keyup", (e) => handleStrictKeyEvent(e, 0), true);

    // BỘ ĐỒNG BỘ HAI CHIỀU (NƯƠNG NHAU): Cứ mỗi 2 giây, máy này tự gửi trạng thái game của mình sang máy kia
    setInterval(() => {
        if (window.EJS_emulator && window.EJS_emulator.gameManager && dataChannel && dataChannel.readyState === "open") {
            window.EJS_emulator.gameManager.getState((stateData) => {
                if (stateData) {
                    dataChannel.send(JSON.stringify({
                        type: "p2p_share_state",
                        gameState: Array.from(new Uint8Array(stateData))
                    }));
                }
            });
        }
    }, 2000);
}

function handleStrictKeyEvent(event, value) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;
    if (!(pressedKey in KEY_TO_BUTTON_ID)) return;

    event.preventDefault();
    event.stopPropagation();

    const buttonId = KEY_TO_BUTTON_ID[pressedKey];

    if (isHost) {
        // MÁY 1 (HOST): Chỉ bấm dải phím P1 và kích hoạt Player 1 tại máy mình
        if (P1_KEYS.includes(pressedKey)) {
            executeDirectGamepadInput(1, buttonId, value);

            // Bắn tín hiệu phím Player 1 sang để Máy 2 cũng nhìn thấy nhân vật 1 di chuyển
            dataChannel.send(JSON.stringify({
                type: "sync_keypress",
                player: 1,
                button: buttonId,
                value: value
            }));
        }
    } else {
        // MÁY 2 (GUEST): Người vào sau bấm phím di chuyển hệ thống ÉP THÀNH PLAYER 2
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            let mappedP2Key = P2_KEYS[keyIndex];
            const p2ButtonId = KEY_TO_BUTTON_ID[mappedP2Key];

            // Ăn nút Player 2 ngay trên chính Máy 2 của mình
            executeDirectGamepadInput(2, p2ButtonId, value);

            // Bắn tín hiệu phím Player 2 sang để Máy 1 nhìn thấy nhân vật 2 di chuyển công bằng
            dataChannel.send(JSON.stringify({
                type: "sync_keypress",
                player: 2,
                button: p2ButtonId,
                value: value
            }));
        }
    }
}

// Hàm tiêm nhị phân đồng thời vào API C++ snes9x và bộ nhớ mô phỏng EmulatorJS
function executeDirectGamepadInput(targetPlayer, buttonId, value) {
    if (window.EJS_emulator) {
        try {
            const playerGamepadIndex = (parseInt(targetPlayer) === 2) ? 1 : 0; // Cổng 0 = P1, Cổng 1 = P2
            
            if (window.EJS_emulator.api && typeof window.EJS_emulator.api.setGamepadState === "function") {
                window.EJS_emulator.api.setGamepadState(playerGamepadIndex, buttonId, value);
            }
            if (window.EJS_emulator.gameManager && typeof window.EJS_emulator.gameManager.simulateInput === "function") {
                window.EJS_emulator.gameManager.simulateInput(playerGamepadIndex, buttonId, value);
            }
        } catch(err){}
    }
}
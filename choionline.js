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

// BẢNG ÁNH XẠ NÚT BẤM CƠ HỌC (Map phím sang mã Button ID chuẩn của Snes9x)
const P1_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "x", "Shift", "Enter"];
const P2_KEYS = ["w", "s", "a", "d", "i", "o", "c", "v"];

const KEY_TO_BUTTON_ID = {
    "ArrowUp": 0, "ArrowDown": 1, "ArrowLeft": 2, "ArrowRight": 3, "z": 8, "x": 9, "Shift": 11, "Enter": 10,
    "w": 0, "s": 1, "a": 2, "d": 3, "i": 8, "o": 9, "c": 11, "v": 10
};

// Cấu hình số người chơi tối đa trên hệ thống
window.EJS_players = 2;
window.EJS_maxPlayers = 2;
window.EJS_gamepad = true;

// Hàm kích hoạt cổng thiết bị khi Snes9x bắt đầu nạp
window.EJS_onGameStart = function() {
    console.log("🎮 Lõi giả lập khởi động. Thiết lập cổng phần cứng Snes9x...");
    if (window.EJS_emulator && window.EJS_emulator.api) {
        try {
            if (typeof window.EJS_emulator.api.setControllerPortDevice === "function") {
                // Ép cả 2 cổng nhận diện tay cầm Joypad chuẩn (Giá trị 1 = RETRO_DEVICE_JOYPAD)
                window.EJS_emulator.api.setControllerPortDevice(0, 1);
                window.EJS_emulator.api.setControllerPortDevice(1, 1);
            }
        } catch (err) {
            console.log("Lỗi cấu hình API phần cứng:", err);
        }
    }
};

// Theo dõi kết nối Firebase
db.ref(".info/connected").on("value", (snapshot) => {
    if (snapshot.val() === false) {
        console.log("⚠️ Mất kết nối mạng hoặc Firebase đang tải lại...");
    } else {
        console.log("✅ Kết nối Firebase ổn định.");
    }
});

// KIỂM TRA ĐƯỜNG DẪN URL (NẾU CÓ PARAM ROOM THÌ LÀ MÁY GUEST)
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
        if(body) body.innerHTML = `<p style='color:#00ffcc;'>🎮 Bạn là <b>Máy 2 (Guest)</b>. Đang kết nối tới Máy 1...</p><p id='join-status'>⌛ Đang đợi Máy 1 gửi tình hình game để kích hoạt...</p>`;
        
        // Máy 2 vào phòng nhưng CHƯA gọi startGame
        joinOnlineRoom(currentRoomId, gameParam);
    }
});

// --- CHỨC NĂNG 1: TẠO PHÒNG (DÀNH CHO MÁY 1 - HOST) ---
function createOnlineRoom() {
    isOnlineMode = true;
    isHost = true;
    myRole = "host";
    pendingCandidates = []; 
    
    if (peerConnection) { try { peerConnection.close(); } catch(e){} }
    
    // Tự động dọn phòng cũ
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
    
    const roomLink = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}&game=${encodeURIComponent(currentSelectedRomUrl)}`;
    document.getElementById("room-link-input").value = roomLink;
    document.getElementById("room-info-section").style.display = "block";
    
    roomRef.set({
        gameUrl: currentSelectedRomUrl,
        gameName: currentSelectedRomName,
        status: "waiting",
        createdAt: firebase.database.ServerValue.TIMESTAMP
    });

    // Khi Máy 2 phản hồi kết nối mạng thành công
    roomRef.child("answer").on("value", async (snapshot) => {
        const answer = snapshot.val();
        if (answer && peerConnection && peerConnection.signalingState === "have-local-offer") {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log("🟢 Kết nối P2P thành công!");
                processPendingCandidates();

                // Máy 1 load game trước để chạy nền
                const emulatorEl = document.querySelector("#emulator");
                if (!emulatorEl || emulatorEl.innerHTML === "") {
                    if (typeof closeOnlineModal === "function") closeOnlineModal();
                    startGame(currentSelectedRomUrl, currentSelectedRomName);
                }
            } catch(err) {
                console.log("Lỗi bắt tay mạng máy Host:", err);
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

function processPendingCandidates() {
    if (peerConnection && peerConnection.remoteDescription) {
        while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {});
        }
    }
}

function copyRoomLink() {
    const copyText = document.getElementById("room-link-input");
    copyText.select();
    navigator.clipboard.writeText(copyText.value);
    alert("Đã sao chép link phòng!");
}

// --- CHỨC NĂNG 2: THAM GIA PHÒNG (DÀNH CHO MÁY 2 - GUEST) ---
async function joinOnlineRoom(roomId, gameUrl) {
    const roomRef = db.ref("rooms/" + roomId);
    pendingCandidates = []; 
    
    if (peerConnection) { try { peerConnection.close(); } catch(e){} }
    
    roomRef.once("value", async (snapshot) => {
        const roomData = snapshot.val();
        if (!roomData) {
            alert("Phòng chơi không tồn tại!");
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
        
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            const answerObj = JSON.parse(JSON.stringify(answer));
            await roomRef.update({ answer: answerObj, status: "connected" });
            processPendingCandidates();
        } catch(err) {
            console.log("Lỗi cấu hình mạng Máy 2:", err);
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
            const candidateObj = JSON.parse(JSON.stringify(event.candidate));
            roomRef.child("hostCandidates").push(candidateObj);
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

// --- CHỨC NĂNG 3: ĐỒNG BỘ DÒNG THỜI GIAN VÀ DỮ LIỆU GAME ĐÚNG NHƯ ANH NGHĨ ---
function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        console.log("🚀 Kênh P2P thông suốt.");
        setupOnlineKeySync();

        // NẾU LÀ MÁY 1 (HOST): Trích xuất tình hình game hiện tại gửi cho Máy 2 kích hoạt
        if (isHost) {
            const syncStateToGuest = () => {
                if (window.EJS_emulator && window.EJS_emulator.gameManager) {
                    try {
                        window.EJS_emulator.gameManager.getState((stateData) => {
                            if (stateData && dataChannel && dataChannel.readyState === "open") {
                                const stateArray = Array.from(new Uint8Array(stateData));
                                dataChannel.send(JSON.stringify({
                                    type: "activate_player_2", // Lệnh kích hoạt máy 2
                                    gameState: stateArray
                                }));
                                console.log("⚙️ Đã gửi tình hình game hiện tại để kích hoạt Máy 2.");
                            }
                        });
                    } catch (e) {
                        setTimeout(syncStateToGuest, 500);
                    }
                } else {
                    setTimeout(syncStateToGuest, 500);
                }
            };
            setTimeout(syncStateToGuest, 2500); // Chờ game chạy ổn định rồi chụp bộ nhớ gửi đi
        }
    };
    
    dataChannel.onclose = () => {
        console.log("⚠️ Mất kết nối bạn chơi.");
    };

    // LUỒNG NHẬN VÀ XỬ LÝ LỆNH TỪ ĐỐI THỦ
    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        // LÀ MÁY 2 (GUEST): Nhận lệnh kích hoạt kèm dữ liệu bộ nhớ từ Máy 1
        if (msg.type === "activate_player_2" && !isHost) {
            console.log("✅ Đã nhận được tình hình game từ Máy 1. Kích hoạt Máy 2...");
            if (typeof closeOnlineModal === "function") closeOnlineModal();
            
            // Bước 1: Máy 2 khởi động game muộn
            startGame(currentSelectedRomUrl, currentSelectedRomName);
            
            // Bước 2: Ép dữ liệu bộ nhớ trùng khớp hoàn toàn với máy 1
            const forceLoadState = () => {
                if (window.EJS_emulator && window.EJS_emulator.gameManager) {
                    try {
                        const u8Array = new Uint8Array(msg.gameState);
                        window.EJS_emulator.gameManager.loadState(u8Array);
                        console.log("⚡ Máy 2 đã đồng bộ dòng thời gian game khớp 100% với Máy 1!");
                    } catch(err) {
                        setTimeout(forceLoadState, 200);
                    }
                } else {
                    setTimeout(forceLoadState, 200);
                }
            };
            setTimeout(forceLoadState, 1500);
        }

        // LÀ MÁY 1 (HOST): Nhận lệnh bấm nút từ Máy 2 gửi tới và ép vào cổng Player 2
        if (msg.type === "guest_keypress" && isHost) {
            executeDirectGamepadInput(2, msg.button, msg.value);
        }
        
        // MÁY 2 (GUEST): Nhận cập nhật trạng thái game liên tục từ máy 1 để chống lệch hình
        if (msg.type === "live_sync_state" && !isHost) {
            if (window.EJS_emulator && window.EJS_emulator.gameManager) {
                try {
                    window.EJS_emulator.gameManager.loadState(new Uint8Array(msg.gameState));
                } catch(e){}
            }
        }
    };
}

// --- CHỨC NĂNG 4: BỘ ĐÁNH CHẶN VÀ CHUYỂN HƯỚNG TÍN HIỆU PHÍM ---
function setupOnlineKeySync() {
    if (!isOnlineMode) return;

    // Vô hiệu hóa và chặn đứng bộ đọc phím mặc định của EmulatorJS trên cả 2 máy
    const cleanInterval = setInterval(() => {
        if (window.EJS_emulator && window.EJS_emulator.gameManager && window.EJS_emulator.gameManager.handleKeyDown) {
            window.removeEventListener("keydown", window.EJS_emulator.gameManager.handleKeyDown);
            window.removeEventListener("keyup", window.EJS_emulator.gameManager.handleKeyUp);
            window.EJS_emulator.gameManager.handleKeyDown = function(e){ e.preventDefault(); };
            window.EJS_emulator.gameManager.handleKeyUp = function(e){ e.preventDefault(); };
            clearInterval(cleanInterval);
            console.log("🔥 Đã khóa cơ chế phím mặc định.");
        }
    }, 100);

    window.addEventListener("keydown", (e) => handleStrictKeyEvent(e, 1), true);
    window.addEventListener("keyup", (e) => handleStrictKeyEvent(e, 0), true);

    // [VÒNG ĐỒNG BỘ LIÊN TỤC] Nếu là Máy 1, cứ mỗi 3 giây chụp ảnh bộ nhớ gửi sang Máy 2 để hai máy không bao giờ bị lệch vị trí
    if (isHost) {
        setInterval(() => {
            if (window.EJS_emulator && window.EJS_emulator.gameManager && dataChannel && dataChannel.readyState === "open") {
                window.EJS_emulator.gameManager.getState((stateData) => {
                    if (stateData) {
                        dataChannel.send(JSON.stringify({
                            type: "live_sync_state",
                            gameState: Array.from(new Uint8Array(stateData))
                        }));
                    }
                });
            }
        }, 3000);
    }
}

function handleStrictKeyEvent(event, value) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;
    if (!(pressedKey in KEY_TO_BUTTON_ID)) return;

    event.preventDefault();
    event.stopPropagation();

    const buttonId = KEY_TO_BUTTON_ID[pressedKey];

    if (isHost) {
        // MÁY 1 (HOST): Phím bấm ăn thẳng vào Player 1 tại máy mình
        if (P1_KEYS.includes(pressedKey)) {
            executeDirectGamepadInput(1, buttonId, value);
        }
    } else {
        // MÁY 2 (GUEST): Người chơi bấm phím (ví dụ dải mũi tên P1_KEYS)
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            let mappedP2Key = P2_KEYS[keyIndex];
            const p2ButtonId = KEY_TO_BUTTON_ID[mappedP2Key];

            // KHÔNG xử lý nội bộ, gửi thẳng lệnh bấm nút này sang Máy 1 xử lý
            dataChannel.send(JSON.stringify({
                type: "guest_keypress",
                button: p2ButtonId,
                value: value
            }));
        }
    }
}

// Hàm ép nút vào lõi C++ của Snes9x
function executeDirectGamepadInput(targetPlayer, buttonId, value) {
    if (window.EJS_emulator) {
        try {
            const playerGamepadIndex = (parseInt(targetPlayer) === 2) ? 1 : 0;
            if (window.EJS_emulator.api && typeof window.EJS_emulator.api.setGamepadState === "function") {
                window.EJS_emulator.api.setGamepadState(playerGamepadIndex, buttonId, value);
            }
            if (window.EJS_emulator.gameManager && typeof window.EJS_emulator.gameManager.simulateInput === "function") {
                window.EJS_emulator.gameManager.simulateInput(playerGamepadIndex, buttonId, value);
            }
        } catch(err){}
    }
}
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

// BẢNG ÁNH XẠ NÚT BẤM SANG MÃ RETROARCH BUTTON ID TRONG SNES9X
// 0: Up, 1: Down, 2: Left, 3: Right, 8: A, 9: B, 11: Select, 10: Start
const P1_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "x", "Shift", "Enter"];
const P2_KEYS = ["w", "s", "a", "d", "i", "o", "c", "v"];

const KEY_TO_BUTTON_ID = {
    "ArrowUp": 0, "ArrowDown": 1, "ArrowLeft": 2, "ArrowRight": 3,
    "z": 8, "x": 9, "Shift": 11, "Enter": 10,
    "w": 0, "s": 1, "a": 2, "d": 3,
    "i": 8, "o": 9, "c": 11, "v": 10
};

// Ép cấu hình số lượng người chơi cho EmulatorJS từ đầu
window.EJS_players = 2;
window.EJS_maxPlayers = 2;
window.EJS_gamepad = true;

window.EJS_onGameStart = function() {
    console.log("🎮 Lõi giả lập bắt đầu chạy - Tiến hành phân tách thiết bị phần cứng ảo Snes9x...");
    if (window.EJS_emulator && window.EJS_emulator.api) {
        try {
            if (typeof window.EJS_emulator.api.setControllerPortDevice === "function") {
                // Ép cả 2 cổng nhận diện dạng RETRO_DEVICE_JOYPAD (giá trị 1)
                window.EJS_emulator.api.setControllerPortDevice(0, 1);
                window.EJS_emulator.api.setControllerPortDevice(1, 1);
                console.log("✅ Đã ép cấu hình cổng snes9x: Port 0 & Port 1 -> RETRO_DEVICE_JOYPAD");
            }
        } catch (err) {
            console.log("Lỗi ép cổng thiết bị tầng API:", err);
        }
    }
};

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
        
        const title = document.getElementById("online-title");
        if(title) title.textContent = "KẾT NỐI CHƠI ONLINE";
        
        const body = document.getElementById("online-body");
        if(body) body.innerHTML = `<p style='color:#00ffcc;'>🎮 Đang tham gia phòng: <b>${currentRoomId}</b></p><p id='join-status'>⚡ Đang thiết lập kết nối mạng P2P...</p>`;
        
        joinOnlineRoom(currentRoomId, gameParam);
    }
});

function createOnlineRoom() {
    isOnlineMode = true;
    isHost = true;
    myRole = "host";
    pendingCandidates = []; 
    
    if (peerConnection) {
        try { peerConnection.close(); } catch(e){}
    }
    
    const now = Date.now();
    const twelveHours = 12 * 60 * 60 * 1000; 
    
    db.ref("rooms").once("value", (snapshot) => {
        const rooms = snapshot.val();
        if (rooms) {
            Object.keys(rooms).forEach(roomId => {
                const room = rooms[roomId];
                if (!room.createdAt || (now - room.createdAt) > twelveHours) {
                    db.ref("rooms/" + roomId).remove()
                        .then(() => console.log(`🗑️ Đã xóa dọn dẹp phòng cũ tránh tràn Firebase: ${roomId}`))
                        .catch(e => console.log("Lỗi dọn dẹp:", e));
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

    roomRef.child("answer").on("value", async (snapshot) => {
        const answer = snapshot.val();
        if (answer && peerConnection && peerConnection.signalingState === "have-local-offer") {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log("🟢 Đồng bộ mạng P2P thành công!");
                
                const statusEl = document.getElementById("connection-status");
                if (statusEl) {
                    statusEl.textContent = "🟢 Đã kết nối bạn chơi! Trận đấu bắt đầu...";
                    statusEl.style.color = "#00ffcc";
                }
                
                processPendingCandidates();

                const emulatorEl = document.querySelector("#emulator");
                if (!emulatorEl || emulatorEl.innerHTML === "") {
                    setTimeout(() => {
                        if (typeof closeOnlineModal === "function") closeOnlineModal();
                        startGame(currentSelectedRomUrl, currentSelectedRomName);
                    }, 1000);
                } else {
                    if (typeof closeOnlineModal === "function") closeOnlineModal();
                }
            } catch(err) {
                console.log("Lỗi cấu hình bắt tay mạng:", err);
            }
        }
    });

    roomRef.child("guestCandidates").on("child_added", (snapshot) => {
        const candidate = snapshot.val();
        if (candidate && peerConnection) {
            if (!peerConnection.remoteDescription) {
                pendingCandidates.push(candidate);
            } else {
                peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {});
            }
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
    copyText.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(copyText.value);
    alert("Đã copy link phòng! Hãy gửi link này cho bạn chơi qua Zalo nhé.");
}

async function joinOnlineRoom(roomId, gameUrl) {
    const roomRef = db.ref("rooms/" + roomId);
    pendingCandidates = []; 
    
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
                    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {});
                }
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
        
        const offerObj = JSON.parse(JSON.stringify(offer));
        await roomRef.update({ offer: offerObj });
    } catch(err) {
        console.log("Lỗi tạo mã khởi tạo mạng:", err);
    }
}

function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        console.log("🚀 Đường truyền WebRTC đã kết nối thành công!");
        
        // Chạy bộ bẻ khóa luồng phím
        setupOnlineKeySync();

        if (isHost) {
            const checkAndSyncState = () => {
                if (window.EJS_emulator && window.EJS_emulator.gameManager) {
                    try {
                        window.EJS_emulator.gameManager.getState((stateData) => {
                            if (stateData && dataChannel && dataChannel.readyState === "open") {
                                const stateArray = Array.from(new Uint8Array(stateData));
                                dataChannel.send(JSON.stringify({
                                    type: "sync_current_game_state",
                                    gameState: stateArray
                                }));
                                console.log("⚙️ Đã đồng bộ ảnh chụp dòng thời gian game hiện tại sang máy Khách.");
                            }
                        });
                    } catch (e) {
                        console.log("Chưa thể trích xuất Save State, thử lại sau...", e);
                    }
                }
            };
            setTimeout(checkAndSyncState, 2000); 
        }

        if (!isHost) {
            const joinStatusEl = document.getElementById("join-status");
            if(joinStatusEl) joinStatusEl.textContent = "🟢 Đang nạp lại trạng thái trận đấu...";
            
            const emulatorEl = document.querySelector("#emulator");
            if (!emulatorEl || emulatorEl.innerHTML === "") {
                setTimeout(() => {
                    if (typeof closeOnlineModal === "function") closeOnlineModal();
                    startGame(currentSelectedRomUrl, currentSelectedRomName);
                }, 1000);
            } else {
                if (typeof closeOnlineModal === "function") closeOnlineModal();
            }
        }
    };
    
    dataChannel.onclose = () => {
        console.log("⚠️ Đường truyền mạng P2P cục bộ bị đóng.");
        
        const statusEl = document.getElementById("connection-status");
        if (statusEl) {
            statusEl.textContent = "⚠️ Bạn chơi đã mất kết nối. Bạn vẫn có thể chơi tiếp một mình!";
            statusEl.style.color = "#ff9900";
        }

        if (!isHost && isOnlineMode && currentRoomId) {
            setTimeout(() => {
                joinOnlineRoom(currentRoomId, currentSelectedRomUrl);
            }, 3000);
        }
        
        if (isHost && currentRoomId) {
            const roomRef = db.ref("rooms/" + currentRoomId);
            roomRef.child("answer").remove();
            roomRef.child("guestCandidates").remove();
            roomRef.child("hostCandidates").remove();
            
            setTimeout(() => {
                setupWebRTC(roomRef);
            }, 2000);
        }
    };

    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "gamepad_input") {
            executeDirectGamepadInput(msg.player, msg.button, msg.value);
        }
        
        if (msg.type === "sync_current_game_state" && !isHost) {
            const tryLoadState = () => {
                if (window.EJS_emulator && window.EJS_emulator.gameManager) {
                    try {
                        const u8Array = new Uint8Array(msg.gameState);
                        window.EJS_emulator.gameManager.loadState(u8Array);
                        console.log("✅ Đã kéo dòng thời gian game khớp 100% với chủ phòng!");
                    } catch(err) {
                        setTimeout(tryLoadState, 500);
                    }
                } else {
                    setTimeout(tryLoadState, 500);
                }
            };
            setTimeout(tryLoadState, 1500);
        }
    };
}

// --- CHỨC NĂNG 4: BỘ ĐÁNH CHẶN VÀ VÔ HIỆU HÓA HOÀN TOÀN TRÌNH QUẢN LÝ PHÍM MẶC ĐỊNH ---
function setupOnlineKeySync() {
    if (!isOnlineMode) return;
    console.log("⌨️ Khởi động luồng bẻ khóa sâu hệ thống phím...");

    // VÒNG LẶP LIÊN TỤC: Đợi đến khi EmulatorJS thực sự gán hàm xử lý của nó thì gỡ bỏ ngay lập tức
    const overrideInterval = setInterval(() => {
        if (window.EJS_emulator && window.EJS_emulator.gameManager && window.EJS_emulator.gameManager.handleKeyDown) {
            try {
                window.removeEventListener("keydown", window.EJS_emulator.gameManager.handleKeyDown);
                window.removeEventListener("keyup", window.EJS_emulator.gameManager.handleKeyUp);
                
                // Ghi đè rỗng luôn hàm nội bộ của nó để loại bỏ tận gốc cơ chế tự nhận phím
                window.EJS_emulator.gameManager.handleKeyDown = function(e) { e.preventDefault(); };
                window.EJS_emulator.gameManager.handleKeyUp = function(e) { e.preventDefault(); };
                
                clearInterval(overrideInterval);
                console.log("🔥 Đã vô hiệu hóa thành công bộ điều khiển phím gốc của EmulatorJS!");
            } catch (e) {
                console.log("Đang thử lại việc gỡ bộ lắng nghe phím...", e);
            }
        }
    }, 100);

    // Đăng ký bộ lắng nghe phím độc lập mới, chặn đứng lan truyền (Capture Mode = true)
    window.addEventListener("keydown", (e) => handleStrictKeyEvent(e, 1), true);
    window.addEventListener("keyup", (e) => handleStrictKeyEvent(e, 0), true);
}

function handleStrictKeyEvent(event, value) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;
    if (!(pressedKey in KEY_TO_BUTTON_ID)) return;

    // Chặn đứng hoàn toàn không cho trình duyệt đẩy phím text vào Core WASM
    event.preventDefault();
    event.stopPropagation();

    const buttonId = KEY_TO_BUTTON_ID[pressedKey];

    if (isHost) {
        // NGƯỜI VÀO ĐẦU (HOST) -> CHỈ NHẬN DI CHUYỂN CHO TAY CẦM 1 (Index = 0)
        if (P1_KEYS.includes(pressedKey)) {
            executeDirectGamepadInput(1, buttonId, value);

            dataChannel.send(JSON.stringify({
                type: "gamepad_input",
                player: 1,
                button: buttonId,
                value: value
            }));
        }
    } else {
        // NGƯỜI VÀO SAU (GUEST) -> BẤM PHÍM DI CHUYỂN MẶC ĐỊNH SẼ ĐIỀU KHIỂN TAY CẦM 2 (Index = 1)
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            let mappedP2Key = P2_KEYS[keyIndex];
            const p2ButtonId = KEY_TO_BUTTON_ID[mappedP2Key];

            executeDirectGamepadInput(2, p2ButtonId, value);

            dataChannel.send(JSON.stringify({
                type: "gamepad_input",
                player: 2,
                button: p2ButtonId,
                value: value
            }));
        }
    }
}

// Ghi đè trạng thái Tay cầm trực tiếp vào cấu trúc API State nhị phân Libretro của snes9x
function executeDirectGamepadInput(targetPlayer, buttonId, value) {
    if (window.EJS_emulator) {
        try {
            // Định nghĩa chuẩn phần cứng: Player 1 = Cổng 0, Player 2 = Cổng 1
            const playerGamepadIndex = (parseInt(targetPlayer) === 2) ? 1 : 0;

            // Đẩy song song vào cả hai hàm để đảm bảo lõi C++ của snes9x nhận tín hiệu tức thì
            if (window.EJS_emulator.api && typeof window.EJS_emulator.api.setGamepadState === "function") {
                window.EJS_emulator.api.setGamepadState(playerGamepadIndex, buttonId, value);
            }
            if (window.EJS_emulator.gameManager && typeof window.EJS_emulator.gameManager.simulateInput === "function") {
                window.EJS_emulator.gameManager.simulateInput(playerGamepadIndex, buttonId, value);
            }
        } catch(err) {
            // Core đang tải khung hình, bỏ qua
        }
    }
}
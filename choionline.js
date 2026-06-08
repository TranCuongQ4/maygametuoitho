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

// BẢNG ÁNH XẠ NÚT BẤM (MAP PHÍM SANG MÃ RETROARCH BUTTON ID CHUẨN SNES9X)
// 0: Up, 1: Down, 2: Left, 3: Right, 8: A, 9: B, 11: Select(Coin), 10: Start
const P1_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "x", "Shift", "Enter"];
const P2_KEYS = ["w", "s", "a", "d", "i", "o", "c", "v"];

const KEY_TO_BUTTON_ID = {
    // Luồng phím Player 1
    "ArrowUp": 0, "ArrowDown": 1, "ArrowLeft": 2, "ArrowRight": 3,
    "z": 8, "x": 9, "Shift": 11, "Enter": 10,
    // Luồng phím Player 2
    "w": 0, "s": 1, "a": 2, "d": 3,
    "i": 8, "o": 9, "c": 11, "v": 10
};

// --- [CẤU HÌNH VÀNG ĐỂ SNES9X/RETROARCH KÍCH HOẠT 2 TAY CẦM ĐỘC LẬP] ---
// Cần khai báo trực tiếp các biến toàn cục này để cấu trúc EmulatorJS tiêm thẳng vào hàm retro_set_controller_port_device của lõi Snes9x C++
window.EJS_players = 2;
window.EJS_maxPlayers = 2;
window.EJS_gamepad = true; // Bật tính năng ảo hóa thiết bị tay cầm vật lý

// Hàm can thiệp ngay thời điểm lõi WASM vừa được nạp vào bộ nhớ, trước khi chạy khung hình đầu tiên của ROM
window.EJS_onGameStart = function() {
    console.log("🎮 Lõi giả lập bắt đầu chạy - Tiến hành phân tách thiết bị phần cứng ảo Snes9x...");
    
    // Tách biệt cấu hình nội bộ nếu API lõi tồn tại
    if (window.EJS_emulator && window.EJS_emulator.api) {
        try {
            // Ép bộ điều khiển trung tâm nhận diện: Cổng 0 = Tay cầm 1, Cổng 1 = Tay cầm 2
            if (typeof window.EJS_emulator.api.setControllerPortDevice === "function") {
                // 1 đại diện cho RETRO_DEVICE_JOYPAD trong cấu trúc mã nguồn snes9x / libretro.h
                window.EJS_emulator.api.setControllerPortDevice(0, 1);
                window.EJS_emulator.api.setControllerPortDevice(1, 1);
                console.log("✅ Đã ép cấu hình cổng phần cứng: Port 0 và Port 1 -> RETRO_DEVICE_JOYPAD thành công.");
            }
        } catch (err) {
            console.log("Cảnh báo can thiệp tầng API C++ thất bại, chuyển hướng xử lý qua luồng mô phỏng nhị phân...");
        }
    }
};

// --- THEO DÕI TRẠNG THÁI MẠNG ĐỂ TỰ ĐỘNG KHÔI PHỤC KẾT NỐI CỦA FIREBASE ---
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
        
        // Khách tiến hành vào phòng công khai
        joinOnlineRoom(currentRoomId, gameParam);
    }
});

// --- CHỨC NĂNG 1: TẠO PHÒNG VÀ TỰ ĐỘNG DỌN DẸP FIREBASE QUÁ 12 GIỜ (DÀNH CHO HOST) ---
function createOnlineRoom() {
    isOnlineMode = true;
    isHost = true;
    myRole = "host";
    pendingCandidates = []; 
    
    if (peerConnection) {
        try { peerConnection.close(); } catch(e){}
    }
    
    // --- BỘ QUẢN LÝ RESET DỮ LIỆU CHỐNG TRÀN FIREBASE (12 TIẾNG) ---
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

    // Tạo ID phòng ngẫu nhiên gồm 6 chữ số
    currentRoomId = Math.floor(100000 + Math.random() * 900000);
    const roomRef = db.ref("rooms/" + currentRoomId);
    
    // Sinh đường dẫn phòng gửi cho bạn bè
    const roomLink = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}&game=${encodeURIComponent(currentSelectedRomUrl)}`;
    document.getElementById("room-link-input").value = roomLink;
    document.getElementById("room-info-section").style.display = "block";
    
    // Khởi tạo thông tin phòng lên Firebase kèm mốc thời gian thực
    roomRef.set({
        gameUrl: currentSelectedRomUrl,
        gameName: currentSelectedRomName,
        status: "waiting",
        createdAt: firebase.database.ServerValue.TIMESTAMP
    });

    // Lắng nghe tín hiệu Re-connect hoặc Connect mới từ Khách gửi lên
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

                // Nếu game chưa chạy thì mới kích hoạt, nếu đang chạy sẵn (khách vào lại) thì bỏ qua không load lại game
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

    // Lắng nghe các ICE Candidate mới từ khách gửi lên (Dùng để bắt tay lại khi mất mạng)
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

    // Khởi tạo quy trình WebRTC
    setupWebRTC(roomRef);
}

// Hàm giải phóng hàng đợi candidate
function processPendingCandidates() {
    if (peerConnection && peerConnection.remoteDescription) {
        while (pendingCandidates.length > 0) {
            const candidate = pendingCandidates.shift();
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {});
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
            // Cập nhật lên Firebase trạng thái phòng và câu trả lời mạng
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
        console.log("🚀 Đường truyền WebRTC đã kết nối thành công!");
        
        // Kích hoạt bộ đánh chặn và xử lý luồng phím cứng
        setupOnlineKeySync();

        // Nếu là Host, tiến hành chụp ảnh trạng thái game gửi cho Khách
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
            console.log("🔄 Đang thử tự động kết nối lại vào phòng bằng link ban đầu...");
            setTimeout(() => {
                joinOnlineRoom(currentRoomId, currentSelectedRomUrl);
            }, 3000);
        }
        
        if (isHost && currentRoomId) {
            console.log("🔄 Host làm sạch kênh phụ để đón khách quay lại phòng cũ...");
            const roomRef = db.ref("rooms/" + currentRoomId);
            roomRef.child("answer").remove();
            roomRef.child("guestCandidates").remove();
            roomRef.child("hostCandidates").remove();
            
            setTimeout(() => {
                setupWebRTC(roomRef);
            }, 2000);
        }
    };

    // NHẬN TÍN HIỆU TỪ MÁY ĐỐI THỦ
    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        // Nhận lệnh mô phỏng Tay cầm từ luồng mạng
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
                        console.log("Lõi giả lập chưa tải xong ROM, đang đợi để ép đồng bộ...", err);
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

// --- CHỨC NĂNG 4: BỘ ĐÁNH CHẶN VÀ ĐIỀU PHỐI LUỒNG NHẬP LIỆU TAY CẦM ---
function setupOnlineKeySync() {
    if (!isOnlineMode) return;
    console.log("⌨️ Hệ thống bẻ khóa luồng Tay Cầm Độc Lập snes9x đã kích hoạt.");

    // Xóa bỏ hoàn toàn lắng nghe mặc định của EmulatorJS tránh việc nó tự map phím đè lên Player 1
    if (window.EJS_emulator && window.EJS_emulator.gameManager) {
        window.removeEventListener("keydown", window.EJS_emulator.gameManager.handleKeyDown);
        window.removeEventListener("keyup", window.EJS_emulator.gameManager.handleKeyUp);
    }

    // Tự bắt sự kiện bằng Capture Mode ưu tiên cao nhất trong DOM trình duyệt
    window.addEventListener("keydown", (e) => handleStrictKeyEvent(e, 1), true);
    window.addEventListener("keyup", (e) => handleStrictKeyEvent(e, 0), true);
}

function handleStrictKeyEvent(event, value) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;
    
    if (!(pressedKey in KEY_TO_BUTTON_ID)) return;

    // Chặn đứng tuyệt đối không cho trình duyệt đẩy mã phím text tự do vào lõi WASM
    event.preventDefault();
    event.stopPropagation();

    const buttonId = KEY_TO_BUTTON_ID[pressedKey];

    if (isHost) {
        // Máy Host chỉ thu thập dải phím P1 (Mũi tên, Z, X...)
        if (P1_KEYS.includes(pressedKey)) {
            // Đẩy vào cổng tay số 1 của máy Host
            executeDirectGamepadInput(1, buttonId, value);

            // Gửi gói tin tay cầm sang máy Khách để đồng bộ hiển thị màn hình bên đó
            dataChannel.send(JSON.stringify({
                type: "gamepad_input",
                player: 1,
                button: buttonId,
                value: value
            }));
        }
    } else {
        // Máy Khách (Guest) bấm dải phím Mũi tên mặc định (P1_KEYS) nhưng hệ thống tự hiểu gán thành P2
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            let mappedP2Key = P2_KEYS[keyIndex];
            const p2ButtonId = KEY_TO_BUTTON_ID[mappedP2Key];

            // Đẩy vào cổng tay số 2 trên máy Khách
            executeDirectGamepadInput(2, p2ButtonId, value);

            // Bắn tín hiệu tay số 2 sang máy Host để điều khiển nhân vật số 2
            dataChannel.send(JSON.stringify({
                type: "gamepad_input",
                player: 2,
                button: p2ButtonId,
                value: value
            }));
        }
    }
}

// Ép tín hiệu trực tiếp vào cấu trúc API State nhị phân của snes9x
function executeDirectGamepadInput(targetPlayer, buttonId, value) {
    if (window.EJS_emulator && window.EJS_emulator.gameManager) {
        try {
            // Định nghĩa Index thiết bị phần cứng thực tế (Player 1 = 0, Player 2 = 1)
            const playerGamepadIndex = (parseInt(targetPlayer) === 2) ? 1 : 0;

            // Cách 1: Thử nghiệm tiêm trực tiếp bằng bộ mô phỏng phần cứng nhị phân EmulatorJS
            if (typeof window.EJS_emulator.gameManager.simulateInput === "function") {
                window.EJS_emulator.gameManager.simulateInput(playerGamepadIndex, buttonId, value);
            }
            
            // Cách 2: Can thiệp sâu bằng hàm C++ tương thích Libretro của RetroArch (Ghi đè song song để chắc chắn ăn nút)
            if (window.EJS_emulator.api && typeof window.EJS_emulator.api.setGamepadState === "function") {
                window.EJS_emulator.api.setGamepadState(playerGamepadIndex, buttonId, value);
            }
        } catch(err) {
            // Tránh văng lỗi khi lõi chưa ổn định đồ họa hoàn toàn
        }
    }
}
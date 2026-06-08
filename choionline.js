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

// --- [QUAN TRỌNG] CẤU HÌNH ÉP LÕI GIẢ LẬP PHÂN CHIA TAY CẦM 1 VÀ 2 TỪ ĐẦU ---
// Điền cấu hình này vào window trước khi gọi startGame để EmulatorJS không tự map đè phím lung tung
window.EJS_players = 2;
window.EJS_gamePadIndex = 0; 
window.EJS_player = "#emulator";

// Hàm bổ sung cấu hình RetroArch để tách biệt hoàn toàn Player 2 ra khỏi các phím mặc định của Player 1
window.EJS_onGameStart = function() {
    console.log("🎮 Lõi giả lập bắt đầu chạy - Tiến hành cấu hình phân rã Player 1 & 2...");
    if (window.EJS_emulator && window.EJS_emulator.api) {
        // Ép hệ thống nhận diện rõ ràng 2 tay cầm riêng biệt
        try {
            // Thiết lập dải phím cho Player 1 (Mũi tên, Z, X, Shift, Enter)
            const p1Mapping = {
                "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
                "a": "z", "b": "x", "select": "Shift", "start": "Enter"
            };
            // Thiết lập dải phím cho Player 2 (W, A, S, D, I, O, C, V)
            const p2Mapping = {
                "up": "w", "down": "s", "left": "a", "right": "d",
                "a": "i", "b": "o", "select": "c", "start": "v"
            };

            // Thực thi cấu hình ép trực tiếp vào Core
            if(typeof window.EJS_emulator.setControls === "function") {
                window.EJS_emulator.setControls(1, p1Mapping);
                window.EJS_emulator.setControls(2, p2Mapping);
                console.log("✅ Đã phân chia bản đồ phím cứng Player 1 & Player 2 trong lõi hệ thống.");
            }
        } catch(e) {
            console.log("Lỗi cấu hình thiết lập tay cầm đầu vào:", e);
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
        
        // Đăng ký bộ lắng nghe và đồng bộ tổ hợp phím cơ học ngay lập tức
        setupOnlineKeySync();

        // [CƠ CHẾ ĐỒNG BỘ THỜI GIAN THỰC] - Nếu là Host, tiến hành chụp ảnh trạng thái game gửi cho Khách vừa vào
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
            setTimeout(checkAndSyncState, 2000); // Tăng lên 2 giây để đảm bảo lõi đồ họa đã chạy thông suốt hẳn
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

    // NHẬN TÍN HIỆU PHÍM BẤM HOẶC DỮ LIỆU ĐỒNG BỘ TỪ MÁY ĐỐI THỦ
    dataChannel.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "keyup" || msg.type === "keydown") {
            simulateEmulatorKeyEvent(msg.type, msg.key, msg.player);
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

// --- CHỨC NĂNG 4: BỘ ĐIỀU PHỐI ĐÁNH CHẶN VÀ ĐỒNG BỘ PHÍM BÀN PHÍM ---
function setupOnlineKeySync() {
    if (!isOnlineMode) return;
    console.log("⌨️ Hệ thống đánh chặn phân rã luồng Player đã chạy.");

    // ÉP LẠI BIẾN TOÀN CỤC ĐỂ ĐẢM BẢO CHẠY ĐÚNG 2 CỔNG TAY CẦM độc lập
    window.EJS_players = 2; 

    window.addEventListener("keydown", (e) => handleKeyEvent(e, "keydown"), true);
    window.addEventListener("keyup", (e) => handleKeyEvent(e, "keyup"), true);
}

function handleKeyEvent(event, type) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;

    if (isHost) {
        // Nếu là Host (Player 1) -> Chặn tuyệt đối dải phím P2 không cho đè lên cấu hình máy mình
        if (P2_KEYS.includes(pressedKey.toLowerCase())) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        
        // Nếu Host bấm đúng phím Player 1 -> Chạy nội bộ cổng 1 và đồng bộ sang khách
        if (P1_KEYS.includes(pressedKey)) {
            dataChannel.send(JSON.stringify({
                type: type,
                key: pressedKey,
                player: 1
            }));
            simulateEmulatorKeyEvent(type, pressedKey, 1);
            event.preventDefault();
            event.stopPropagation();
        }
    } else {
        // Nếu mình là Khách (Player 2)
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            event.preventDefault();
            event.stopPropagation();
            
            // Dùng dải phím P2 tương ứng
            let mappedP2Key = P2_KEYS[keyIndex];
            
            // Gửi dữ liệu yêu cầu thực thi trên tay số 2 sang cho Host
            dataChannel.send(JSON.stringify({
                type: type,
                key: mappedP2Key,
                player: 2
            }));
            
            simulateEmulatorKeyEvent(type, mappedP2Key, 2);
        }
    }
}

// Hàm giả lập tiêm phím trực tiếp vào cổng cắm điều khiển của đối tượng xử lý EmulatorJS
function simulateEmulatorKeyEvent(type, keyName, targetPlayer) {
    // 1. Giả lập sự kiện mức trình duyệt cho giao diện web ngoài (nếu cần)
    const e = new KeyboardEvent(type, {
        key: keyName,
        bubbles: true,
        cancelable: true
    });
    const emulatorEl = document.querySelector("#emulator");
    if (emulatorEl) {
        emulatorEl.dispatchEvent(e);
    }

    // 2. [CAN THIỆP SÂU VÀO LUỒNG NHỊ PHÂN CỦA CORE] - ÉP BUỘC TÁCH BIỆT CỔNG TAY CẦM ĐỘC LẬP
    if (window.EJS_emulator && window.EJS_emulator.api && typeof window.EJS_emulator.api.setKeyboardState === "function") {
        try {
            // Trong API C++ gốc của RetroArch: Player 1 = Cổng 0, Player 2 = Cổng 1
            const playerIndex = (parseInt(targetPlayer) === 2) ? 1 : 0;
            const isPressed = (type === "keydown");
            
            // Hàm thần thánh ép thẳng vào luồng xử lý phần cứng ảo của game
            window.EJS_emulator.api.setKeyboardState(playerIndex, keyName, isPressed);
        } catch(err) {
            // Core chưa sẵn sàng, bỏ qua tránh crash trang web
        }
    }
}
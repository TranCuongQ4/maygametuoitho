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

// Cấu hình STUN server miễn phí của Google để tìm kiếm địa chỉ IP WAN P2P
const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ]
};

// Mảng bảng phím mặc định của EmulatorJS dành cho Player 1 và Player 2 để chúng ta map tín hiệu mạng
// Player 1 thông thường: Xuống=ArrowDown, Lên=ArrowUp, Trái=ArrowLeft, Phải=ArrowRight, Đấm=Z, Đá=X, Select=Shift, Start=Enter
// Player 2 thông thường: Lên=KeyW, Xuống=KeyS, Trái=KeyA, Phải=KeyD, Đấm=KeyI, Đá=KeyO, Select=KeyC, Start=KeyV
const P1_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "x", "Shift", "Enter"];
const P2_KEYS = ["w", "s", "a", "d", "i", "o", "c", "v"];

// --- KIỂM TRA ĐƯỜNG DẪN URL XEM CÓ PHẢI LÀ KHÁCH CLICK VÀO LINK KHÔNG ---
window.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('room')) {
        currentRoomId = urlParams.get('room');
        const gameParam = urlParams.get('game') || "roms/dino.zip";
        
        isOnlineMode = true;
        isHost = false;
        myRole = "guest";
        
        document.getElementById("online-modal").style.display = "flex";
        document.getElementById("online-title").textContent = "KẾT NỐI CHƠI ONLINE";
        document.getElementById("online-body").innerHTML = `<p style='color:#00ffcc;'>🎮 Đang tham gia phòng: <b>${currentRoomId}</b></p><p id='join-status'>⚡ Đang thiết lập kết nối mạng P2P...</p>`;
        
        // Tiến hành chạy hàm kết nối của khách vào phòng
        joinOnlineRoom(currentRoomId, gameParam);
    }
});

// --- CHỨC NĂNG 1: TẠO PHÒNG (DÀNH CHO CHỦ PHÒNG - HOST) ---
function createOnlineRoom() {
    isOnlineMode = true;
    isHost = true;
    myRole = "host";
    
    // Tạo ID phòng ngẫu nhiên gồm 6 chữ số
    currentRoomId = Math.floor(100000 + Math.random() * 900000);
    
    const roomRef = db.ref("rooms/" + currentRoomId);
    
    // Sinh đường dẫn phòng gửi cho bạn bè
    const roomLink = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}&game=${encodeURIComponent(currentSelectedRomUrl)}`;
    document.getElementById("room-link-input").value = roomLink;
    document.getElementById("room-info-section").style.display = "block";
    
    // Ghi khởi tạo thông tin phòng lên node `rooms/` của Firebase
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
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            document.getElementById("connection-status").textContent = "🟢 Đã kết nối thành công! Trận đấu bắt đầu...";
            document.getElementById("connection-status").style.color = "#00ffcc";
            
            // Đợi 1 giây cho đường ống mạng ổn định rồi kích hoạt màn hình game
            setTimeout(() => {
                closeOnlineModal();
                startGame(currentSelectedRomUrl, currentSelectedRomName);
            }, 1000);
        }
    });

    // Lắng nghe gói định vị ICE mạng từ khách gửi lên
    roomRef.child("guestCandidates").on("child_added", (snapshot) => {
        const candidate = snapshot.val();
        if (candidate && peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    // Khởi tạo quy trình WebRTC Web Connection
    setupWebRTC(roomRef);
}

// Hàm sao chép link phòng nhanh
function copyRoomLink() {
    const copyText = document.getElementById("room-link-input");
    copyText.select();
    copyText.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(copyText.value);
    alert("Đã copy link phòng! Hãy gửi link này cho bạn chơi qua Zalo nhé.");
}

// --- CHỨC NĂNG 2: THAM GIA PHÒNG (DÀNH CHO KHÁCH - GUEST) ---
async function joinOnlineRoom(roomId, gameUrl) {
    const roomRef = db.ref("rooms/" + roomId);
    
    // Đọc thông tin phòng từ Firebase để lấy chuẩn file ROM đồng bộ với chủ phòng
    roomRef.once("value", async (snapshot) => {
        const roomData = snapshot.val();
        if (!roomData) {
            alert("Phòng chơi không tồn tại hoặc đã bị hủy!");
            window.location.href = window.location.pathname;
            return;
        }
        
        currentSelectedRomUrl = roomData.gameUrl;
        currentSelectedRomName = roomData.gameName;

        peerConnection = new RTCPeerConnection(rtcConfig);
        
        // Đón nhận cổng truyền dữ liệu từ phía Host tạo ra
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannelEvents();
        };

        // Gửi thông tin định vị mạng ICE lên Firebase cho Host nhận diện
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                roomRef.child("guestCandidates").push(event.candidate.toJSON());
            }
        };

        // Lấy mã Offer kết nối của chủ phòng từ Firebase xuống
        const offerSnapshot = await roomRef.child("offer").once("value");
        const offer = offerSnapshot.val();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

        // Tạo mã trả lời mạng (Answer) gửi ngược lên lại Firebase
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await roomRef.update({ answer: answer.toJSON(), status: "connected" });

        // Lắng nghe mã định vị ICE của Host
        roomRef.child("hostCandidates").on("child_added", (snapshot) => {
            const candidate = snapshot.val();
            if (candidate && peerConnection) {
                peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
        });
    });
}

// --- CHỨC NĂNG 3: KHỞI TẠO ĐƯỜNG TRUYỀN WEBRTC ---
async function setupWebRTC(roomRef) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    
    // Chủ phòng chủ động mở luồng ống truyền dữ liệu Data Channel đặt tên là "gameControls"
    dataChannel = peerConnection.createDataChannel("gameControls", { ordered: false }); // thiết lập không tuần tự để truyền nút bấm thời gian thực nhanh nhất
    setupDataChannelEvents();

    // Gửi thông tin định vị mạng ICE của Host lên Firebase
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            roomRef.child("hostCandidates").push(event.candidate.toJSON());
        }
    };

    // Tạo mã Offer kết nối mạng ban đầu và đẩy lên Firebase
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await roomRef.update({ offer: offer.toJSON() });
}

// Cấu hình sự kiện mở đóng của đường truyền data channel
function setupDataChannelEvents() {
    dataChannel.onopen = () => {
        console.log("Đường truyền WebRTC Đã Mở!");
        if (!isHost) {
            document.getElementById("join-status").textContent = "🟢 Đang vào game cùng chủ phòng...";
            setTimeout(() => {
                closeOnlineModal();
                startGame(currentSelectedRomUrl, currentSelectedRomName);
            }, 1000);
        }
    };
    
    dataChannel.onclose = () => {
        console.log("Mất kết nối mạng!");
        alert("Bạn chơi đã thoát phòng hoặc mất kết nối mạng!");
        forceCloseGame();
    };

    // NHẬN TÍN HIỆU PHÍM BẤM TỪ MÁY ĐỐI THỦ GỬI SANG
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

    // Đánh chặn sự kiện gõ phím hệ thống
    window.addEventListener("keydown", (e) => handleKeyEvent(e, "keydown"), true);
    window.addEventListener("keyup", (e) => handleKeyEvent(e, "keyup"), true);
}

function handleKeyEvent(event, type) {
    if (!isOnlineMode || !dataChannel || dataChannel.readyState !== "open") return;

    const pressedKey = event.key;

    if (isHost) {
        // TẠI MÁY HOST (CHỦ PHÒNG) - ĐIỀU KHIỂN PLAYER 1
        // Nếu Host nhấn nhầm cụm phím của Player 2, chặn không cho tác động nội bộ máy
        if (P2_KEYS.includes(pressedKey.toLowerCase())) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        
        // Nếu Host bấm các phím Player 1, cho phép chạy và gửi mã nút sang máy Guest
        if (P1_KEYS.includes(pressedKey)) {
            dataChannel.send(JSON.stringify({
                type: type,
                key: pressedKey,
                player: 1 // Báo cho Guest biết đây là phím của Player 1
            }));
        }
    } else {
        // TẠI MÁY GUEST (KHÁCH) - ĐIỀU KHIỂN PLAYER 2
        // Khi Guest bấm cụm phím Player 1 thông thường trên máy họ, ta biến nó thành phím của Player 2
        let keyIndex = P1_KEYS.indexOf(pressedKey);
        if (keyIndex !== -1) {
            // Chặn đứng hành vi điều khiển Player 1 nội bộ trên màn hình máy khách
            event.preventDefault();
            event.stopPropagation();
            
            // Lấy phím tương ứng ở bảng Player 2 để gửi đi
            let mappedP2Key = P2_KEYS[keyIndex];
            
            dataChannel.send(JSON.stringify({
                type: type,
                key: mappedP2Key,
                player: 2 // Báo cho Host biết đây là phím của Player 2
            }));
            
            // Tự kích hoạt phím Player 2 đó ngay trên màn hình Emulator máy mình để điều khiển nhân vật 2
            simulateEmulatorKeyEvent(type, mappedP2Key, 2);
        }
    }
}

// Hàm giả lập tiêm phím cơ học trực tiếp vào đối tượng xử lý EmulatorJS của trình duyệt
function simulateEmulatorKeyEvent(type, keyName, targetPlayer) {
    // Tạo ra sự kiện giả lập bàn phím chuẩn cấu trúc trình duyệt
    const e = new KeyboardEvent(type, {
        key: keyName,
        bubbles: true,
        cancelable: true
    });
    
    // Bơm sự kiện này vào thẳng phần tử chứa Emulator
    const emulatorEl = document.querySelector(window.EJS_player || "#emulator");
    if (emulatorEl) {
        emulatorEl.dispatchEvent(e);
    }
}
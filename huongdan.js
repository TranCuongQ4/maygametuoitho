// Hàm tạo và hiển thị bảng Hướng Dẫn Sử Dụng dạng Modal popup
function xemHuongDan() {
    // 1. Kiểm tra xem bảng hướng dẫn đã tồn tại chưa để tránh tạo trùng lặp
    if (document.getElementById('huongdan-modal')) {
        document.getElementById('huongdan-modal').style.display = 'flex';
        return;
    }

    // 2. Tạo khung Container cho Modal (Nền tối mờ phía sau)
    var modal = document.createElement('div');
    modal.id = 'huongdan-modal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';
    modal.style.zIndex = '99999';
    modal.style.padding = '20px';
    modal.style.boxSizing = 'border-box';

    // 3. Tạo nội dung Bảng màu xanh chữ trắng bên trong
    var box = document.createElement('div');
    box.style.backgroundColor = '#0b6623'; // Màu xanh lá đậm ngọc bích sang trọng
    box.style.border = '2px solid #00ffcc';
    box.style.borderRadius = '15px';
    box.style.padding = '25px';
    box.style.maxWidth = '400px';
    box.style.width = '100%';
    box.style.boxShadow = '0px 10px 30px rgba(0,0,0,0.5)';
    box.style.textAlign = 'center';
    box.style.boxSizing = 'border-box';

    // 4. Nội dung văn bản cấu trúc theo yêu cầu của bạn
    box.innerHTML = `
        <h2 style="color: #ffcc00; margin-top: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 1px; text-shadow: 1px 1px #000;">Hướng Dẫn Sử Dụng</h2>
        <p style="color: #ffffff; font-size: 15px; line-height: 1.6; margin-bottom: 25px; text-align: left;">
            Nhấn vào các game đã chọn sẳn để chơi nhé, muốn thoát nhấn vào dấu 3 gạch rồi có kí hiệu mở cửa mũi tên ra thoát để thoát nếu kẹt ở màn hình thoát nhấn logo X để về lại màn hình chọn game.
        </p>
        <button id="close-hd-btn" style="background: linear-gradient(145deg, #2a2a2a, #222); color: white; border: 1px solid #00ffcc; padding: 10px 30px; font-weight: bold; border-radius: 8px; cursor: pointer; font-size: 15px; transition: all 0.1s;">Đóng</button>
    `;

    // Chèn hộp nội dung vào khung modal nền tối
    modal.appendChild(box);
    // Chèn toàn bộ modal vào body của trang web
    document.body.appendChild(modal);

    // 5. Xử lý sự kiện đóng bảng hướng dẫn khi bấm nút Đóng
    document.getElementById('close-hd-btn').addEventListener('click', function() {
        modal.style.display = 'none';
    });
    
    // Đóng khi bấm ra vùng nền tối phía ngoài
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}
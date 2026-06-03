const CACHE_NAME = 'kho-game-v1';
// Danh sách các file cốt lõi để trang web khởi động được
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/data/loader.js',
    '/huongdan.js',
    // Thêm các file giao diện nếu có (ví dụ: style.css, ảnh...)
];

// Cài đặt: Tải và lưu các file vào cache
self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)));
});

// Fetch: Khi trình duyệt cần file, nó sẽ tìm trong cache trước
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            // Nếu có trong cache thì trả về, không thì mới tải từ mạng
            return response || fetch(event.request).then((fetchResponse) => {
                // Tự động cache các file mới tải về (như file ROM/Core)
                return caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, fetchResponse.clone());
                    return fetchResponse;
                });
            }).catch(() => {
                // Nếu mất mạng và file không có trong cache, trả về trang trống hoặc lỗi
                return new Response('Bạn đang ngoại tuyến!');
            });
        })
    );
});

// Cập nhật: Xóa cache cũ khi có phiên bản mới
self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
});
# Báo cáo Lab 3 Kết nối và duy trì kết nối giữa các service

**Sinh viên:** …………………………  **Mã sinh viên:** …………………………  **Lớp:** …………………………

## 1 Mục tiêu và mô hình

Xây dựng Fee Service cổng 4001 gọi ngân hàng giả lập cổng 4002 qua HTTP. Dữ liệu được giữ trong RAM. Mục tiêu là phân biệt lỗi chắc chắn chưa trừ tiền và kết quả chưa xác định, giới hạn thời gian chờ, tái sử dụng kết nối và retry an toàn.

Luồng: Postman hoặc script → Fee Service → ngân hàng. GET công nợ chỉ đọc RAM của Fee Service nên không phụ thuộc ngân hàng.

## 2 Đối chiếu yêu cầu

| Yêu cầu | Cách thực hiện |
|---|---|
| Dữ liệu ban đầu | SV1 50.000.000đ, SV2 0đ, SV3 3.200.000đ |
| Thanh toán và công nợ | Validate số nguyên dương, giữ chỗ trước await, chỉ giảm debt khi PAID |
| Ngân hàng | POST /charges, 201 + chargeId, 400 sai số tiền, 402 quá 20 triệu |
| Cấu hình lỗi | DELAY_MS, FAIL_RATE, DROP_RATE qua biến môi trường |
| Quan sát kết nối | GET /stats và log từng TCP connection |
| Kết nối lỗi | 503 FAILED nhanh, Fee không sập và tự phục hồi khi bank trở lại |
| Ngân hàng chậm | Timer tổng 4 giây kể cả đợi socket → 504 PENDING |
| Duy trì kết nối | Agent keepAlive, tối đa 10 sockets, LIFO, xử lý socket bị đóng |
| Thử lại | Tối đa 6 attempts tổng cộng, backoff 50/100/200/400/400 ms, cùng key |
| Từ chối nghiệp vụ | Không retry 4xx, giữ mã HTTP, status FAILED |
| Chống trùng | Lưu key và kết quả trước khi mô phỏng cắt kết nối; chặn reference dùng key khác |

## 3 Số liệu đo thực tế

Chạy bằng `v26.8.1` trên `darwin`, bắt đầu lúc `2026-10-20T02:59:44.704Z` (UTC). Nguồn số liệu: `results/verification.json`. Mỗi kịch bản dùng dữ liệu mới; tình huống 1 giữ nguyên tiến trình Fee khi bật lại ngân hàng. Lỗi ngẫu nhiên có thể cho số thành công khác ở lần chạy sau. Chưa kiểm thử trực tiếp bằng Node 18; mã chỉ sử dụng API có từ Node 18 và có kiểm tra thuộc tính dành cho Node mới.

Phiên bản trước sửa là đối chứng dựng bằng MODE=baseline: không retry, tắt pooling và thời hạn 6,5 giây. Các kiểm tra nghiệp vụ và xử lý lỗi kết nối cơ bản vẫn có ở cả hai.

| Phép đo | Trước sửa | Sau sửa | Ngưỡng đề |
|---|---:|---:|---|
| Ngân hàng tắt | 503, 53.78 ms | 503, 15.51 ms | < 1500 ms |
| GET khi ngân hàng tắt | 1.77 ms | 1.63 ms | 200, nhanh |
| Bật lại ngân hàng | 201 | 201 | Không restart Fee |
| DELAY_MS=5000, một POST | 201, 5034.98 ms | 504 PENDING, 4021.81 ms | 504, ≤ 4500 ms |
| 20 POST chậm, thời gian lớn nhất | 5029.5 ms | 4018.21 ms | ≤ 4500 ms |
| GET khi 20 POST đang chờ | 3.65 ms | 4.25 ms | < 300 ms |
| 200 lệnh, concurrency 10 | 200/200 | 200/200 | 200/200 |
| Thời gian 200 lệnh | 99 ms | 84.3 ms | Ghi nhận thực tế |
| Kết nối TCP mới, hiệu stats | 200 | 10 | ≤ 20 |
| Sau nhàn rỗi 6 giây | 5/5 | 5/5 | Thành công |
| DROP_RATE=0.3, PAID | 37/60 | 60/60 | ≥ 54/60 |
| DROP_RATE, charges / duplicates | 60 / 0 | 60 / 0 | duplicates = 0 |
| DROP_RATE, số request ngân hàng | 60 | 76 | Retry cùng khóa |
| FAIL_RATE=0.3, PAID | 35/60 | 60/60 | ≥ 54/60 |
| FAIL_RATE, charges / duplicates | 35 / 0 | 60 / 0 | duplicates = 0 |
| FAIL_RATE, số request ngân hàng | 60 | 80 | Retry cùng khóa |
| Thanh toán 25 triệu | 402, 1 request | 402, 1 request | Không retry |

Các assertions của script đều đạt trong lần chạy này. Kiểm tra bổ sung gồm BANK_URL cổng 4999, số tiền âm/0/thập phân/chuỗi/null, sinh viên không tồn tại, sinh viên không nợ, cùng khóa trả cùng chargeId, khóa cũ với payload khác bị chặn, hai lệnh đồng thời không vượt công nợ.

Đợt DROP_RATE sau sửa: công nợ còn 49,940,000đ = 50.000.000 − 60 × 1.000. Đợt FAIL_RATE sau sửa: còn 49,940,000đ. Duplicates được tăng nếu thực sự có lần commit trừ tiền thứ hai cho cùng reference, không tăng chỉ vì nhận lại request.

## 4 Giải thích các quyết định

### Phân biệt 503 và 504

ECONNREFUSED, lỗi DNS hoặc không có tuyến mạng trước khi thiết lập kết nối chứng tỏ lần thử đó chưa tới ngân hàng. Khi chưa có lần thử mơ hồ nào trước đó, Fee trả 503 FAILED. Timeout hoặc đứt kết nối sau khi đã kết nối không chứng minh được chưa trừ tiền, nên trả 504 PENDING nếu không lấy lại được kết quả bằng retry. Một lần retry không kết nối được không được xóa tính mơ hồ của lần thử trước.

Ngân hàng lab cam kết 500 xảy ra trước khi trừ tiền: có thể retry 500 cùng khóa. Nếu hết attempts và tất cả lần thử đều là 500 rõ ràng trước trừ tiền, trả 503 FAILED. Với hệ thống ngân hàng khác phải kiểm tra lại hợp đồng này.

### Thời hạn tổng và tính bất đồng bộ

Timer 4.000 ms bao trùm toàn bộ lời gọi, bao gồm lúc đợi socket trong pool. Mỗi lần retry chỉ được dùng thời gian còn lại; không được cho mỗi lần thử thêm 4 giây. Dùng setTimeout và I/O bất đồng bộ, không dùng vòng lặp chờ chặn event loop. GET công nợ vì vậy vẫn nhanh khi ngân hàng chậm.

### Keep alive và socket hết hạn

Agent dùng lại tối đa 10 socket, phù hợp batch 10 yêu cầu đồng thời. Ngân hàng đặt keepAliveTimeout=5000; Node mới có buffer được đưa về 0 khi thuộc tính tồn tại. Khi ngân hàng đóng socket, Agent loại khỏi pool; yêu cầu mới mở socket mới. Retry cùng khóa cũng xử lý được trường hợp đóng socket đúng lúc tái sử dụng. TCP keepalive probe không thay thế cơ chế tái sử dụng HTTP connection.

### Idempotency và cập nhật công nợ

Fee tạo mã hiển thị P1, P2… và reference dạng UUID phiên chạy:P1. Mọi attempt của một payment dùng đúng reference đó làm Idempotency-Key. UUID tránh xung đột nếu Fee restart mà ngân hàng vẫn giữ giao dịch cũ. Ngân hàng lưu kết quả trước khi DROP; attempt sau trả lại chargeId đã lưu. Kiểm tra lại Map sau await tránh race do DELAY_MS.

Fee giữ chỗ số tiền trước await để nhiều lệnh đồng thời không vượt công nợ. PAID giảm debt và giải phóng giữ chỗ; FAILED giải phóng giữ chỗ; PENDING giữ nguyên debt và tiếp tục giữ chỗ. Chỉ một nhánh kết thúc cập nhật debt cho mỗi payment. Một HTTP response bị mất không đồng nghĩa giao dịch chưa thực hiện.

## 5 Kịch bản thuyết trình ngắn

1. Giới thiệu hai service và công nợ mẫu, demo một thanh toán bình thường.
2. Tắt ngân hàng: cho xem 503 và GET fees vẫn chạy, bật lại để thấy 201 không restart Fee.
3. Đặt delay 5 giây: chỉ ra 504 PENDING trong 4 giây và giải thích vì sao không được báo thất bại chắc chắn.
4. So sánh số TCP connections trước/sau với batch 200 lệnh, sau đó chờ 6 giây thử lại.
5. Demo DROP_RATE, FAIL_RATE và từ chối 25 triệu; mở stats, đối chiếu PAID, charges, duplicates và công nợ.
6. Kết luận bằng ba nguyên tắc: giới hạn thời gian, retry cùng khóa, chỉ giảm công nợ sau xác nhận.

## 6 Phạm vi và phần cần hoàn thiện khi dùng thực tế

Bài lab dùng RAM đúng đề; chưa có lưu bền, API đối soát PENDING hay xác thực. Cần đối soát giao dịch mơ hồ trước khi giải phóng giữ chỗ hoặc tạo lệnh thay thế. Không thể đảm bảo idempotency xuyên restart ngân hàng khi toàn bộ lịch sử nằm trong RAM. Tỷ lệ lỗi 0,3 là ngẫu nhiên nên ngưỡng 54/60 là kết quả thực nghiệm, không phải lời bảo đảm xác suất tuyệt đối.

## 7 Tài liệu tham khảo

- Đề bài Lab 3 do người học cung cấp.
- Node.js 18 HTTP: https://nodejs.org/docs/latest-v18.x/api/http.html
- Express 4 API: https://expressjs.com/en/4x/api.html

# Lab 3 Kết nối và duy trì kết nối giữa các service

Bài thực hành môn Phát triển phần mềm hướng dịch vụ. Hai service Node.js/Express, dữ liệu trong bộ nhớ, đúng cổng 4001 và 4002. Đọc `BAO-CAO.md` để hiểu thiết kế và kết quả đo; đọc `results/verification.json` để xem số liệu gốc.

## 1 Cài đặt và chạy

Cần Node.js từ 18 và npm. Giải nén, mở terminal tại thư mục chứa `package.json`:

```sh
npm ci
```

Terminal 1:

```sh
npm run bank
```

Terminal 2:

```sh
npm run fee
```

Terminal 3:

```sh
curl http://localhost:4001/students/1/fees
curl -i -X POST http://localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":100000}'
curl http://localhost:4002/stats
```

Trước thanh toán: sinh viên 1 nợ 50.000.000đ, sinh viên 2 nợ 0đ, sinh viên 3 nợ 3.200.000đ. Sau khi thanh toán thành công 100.000đ, sinh viên 1 nợ 49.900.000đ. Kết quả POST có `paymentId: P1`, `status: PAID`, `chargeId`. GET còn có `reserved` là số tiền đang giữ chỗ và `available` là công nợ có thể tiếp tục thanh toán.

Mỗi POST mới là một lệnh thanh toán mới. Retry nội bộ giữ cùng lệnh và cùng khóa; bấm lại POST từ Postman là tạo lệnh mới, không phải retry lệnh cũ.

## 2 Chạy toàn bộ phép đo tự động

Dừng hai service thủ công trước bằng Ctrl+C, để trống cổng 4001, 4002 và 4999, sau đó:

```sh
npm test
```

Script tự khởi động/dừng service, đo cả `baseline` và `fixed`, kiểm tra các điều kiện đề, lưu `results/verification.json`. Khoảng dưới một phút trên máy kiểm thử. Script báo lỗi nếu một điều kiện không đạt; không sửa số liệu hay tự chạy lại để chọn kết quả đẹp. FAIL_RATE và DROP_RATE dùng Math.random nên số liệu khác nhau mỗi lần.

Baseline ở đây là phiên bản đối chứng có xử lý lỗi kết nối cơ bản, nhưng không retry, không tái sử dụng socket, cho chờ tối đa 6,5 giây. Đây là đối chứng được dựng để thực nghiệm, không phải mã ban đầu do giảng viên cung cấp. Mặc định luôn là phiên bản đã sửa.

## 3 Tái hiện từng tình huống bằng tay

Các lệnh dưới dùng cú pháp macOS/Linux. Trên PowerShell, đặt biến bằng `$env:DELAY_MS="5000"; npm run bank`; xóa sau dùng `Remove-Item Env:DELAY_MS`. Dừng và khởi động lại ngân hàng mỗi khi đổi cấu hình. Mỗi đợt đo độc lập nên khởi động mới cả hai service để có dữ liệu ban đầu, ngoại trừ bước phục hồi tình huống 1 phải giữ Fee Service đang chạy.

### Tình huống 1 Ngân hàng tắt rồi bật

Chỉ chạy `npm run fee`, gọi POST thanh toán. Mong đợi 503, FAILED, có error và paymentId, dưới 1,5 giây. Gọi GET fees phải được 200. Sau đó chạy `npm run bank`, gọi POST mới và nhận 201, không restart Fee Service.

Để thử sai cổng, dừng Fee Service rồi chạy:

```sh
BANK_URL=http://localhost:4999 npm run fee
```

Khi không có chương trình trên 4999, POST vẫn trả 503 nhanh. Khởi động lại Fee Service với địa chỉ đúng để thử tiếp.

### Tình huống 2 Ngân hàng chậm

```sh
DELAY_MS=5000 npm run bank
```

Chạy Fee Service bình thường. POST sẽ trả 504 + PENDING khoảng 4 giây. Bắn 20 lệnh đồng thời:

```sh
npm run bench -- 20 20 1000
```

Trong một terminal khác, khi các POST còn chờ:

```sh
curl -s -w '\nThoi gian GET: %{time_total}s\n' http://localhost:4001/students/1/fees
```

GET cần dưới 0,3 giây. Hủy chờ ở Fee Service không hủy giao dịch đã tới ngân hàng; ngân hàng vẫn có thể trừ tiền sau mốc 5 giây. Vì vậy phải trả PENDING, không báo FAILED và không tự giảm công nợ.

### Tình huống 3 Keep alive

Khởi động ngân hàng bình thường. Lần trước sửa chạy Fee Service bằng:

```sh
MODE=baseline npm run fee
npm run bench -- 200 10 1000
```

Sau đó dừng Fee Service, ngân hàng; khởi động lại ngân hàng và Fee Service bình thường, chạy lại lệnh bench. So `paid`, `totalMs`, `connectionsDelta`. Mục tiêu sau sửa: 200/200 và tối đa 20 kết nối ngân hàng mới. Script lấy hiệu stats trước/sau, không dùng tổng tích lũy từ phiên trước. Bản thân request GET stats cũng tạo kết nối TCP; hiệu đo có thể chứa thêm kết nối quan sát nếu client stats mở mới.

Đợi 6 giây, rồi chạy `npm run bench -- 5 1 1000`. Cả 5 phải thành công. Script `npm test` có sẵn bước đợi và kiểm tra này.

### Tình huống 4 Đứt kết nối lỗi 500 và từ chối

Đợt a, khởi động ngân hàng:

```sh
DROP_RATE=0.3 npm run bank
```

Đợt b, dừng và khởi động mới:

```sh
FAIL_RATE=0.3 npm run bank
```

Trong từng đợt chạy Fee Service mới, thực hiện:

```sh
npm run bench -- 60 1 1000
curl http://localhost:4002/stats
curl http://localhost:4001/students/1/fees
```

Mỗi đợt cần ít nhất 54 PAID, duplicates = 0. Công nợ cuối = 50.000.000 − số PAID × 1.000. Với DROP_RATE, nếu vẫn còn PENDING thì charges có thể lớn hơn PAID vì ngân hàng đã trừ nhưng Fee chưa có xác nhận.

Đợt c, chạy mới cả hai service bình thường; gửi 25.000.000đ cho sinh viên 1:

```sh
curl -i -X POST http://localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":25000000}'
curl http://localhost:4002/stats
```

Mong đợi 402 + FAILED và `requests: 1`. Không dùng sinh viên 3 cho phép thử này vì 25 triệu vượt công nợ và bị Fee Service chặn trước khi gọi ngân hàng.

## 4 Postman

Import `PTIT-Lab3.postman_collection.json`. Collection có sẵn các GET, POST và phép thử idempotency trực tiếp tại ngân hàng. Để kiểm tra lỗi, đổi biến môi trường của service từ terminal như phần 3; Postman không thay được biến môi trường của tiến trình đang chạy. Request thanh toán có kiểm tra JSON và ánh xạ status theo HTTP. Hai request idempotency chạy lần lượt sẽ kiểm tra cùng chargeId. Không dùng Collection Runner tuần tự để chứng minh 10/20 yêu cầu đồng thời; dùng script bench.

## 5 Các file chính

- `src/bank.js`: ngân hàng giả lập, lỗi qua biến môi trường, idempotency, stats và log TCP.
- `src/bank-client.js`: HTTP Agent, thời hạn toàn bộ yêu cầu, phân loại lỗi và retry.
- `src/fee.js`: công nợ, giữ chỗ đồng thời, cập nhật khi PAID.
- `scripts/bench.js`: số lượng/concurrency/amount nhận từ dòng lệnh.
- `scripts/verify.js`: kiểm thử tích hợp, so sánh trước/sau và ghi số liệu.
- `BAO-CAO.md`: báo cáo và gợi ý trình bày.

## 6 Giới hạn đúng phạm vi lab

Dữ liệu trong RAM, mất khi restart; không dùng tiền thật. PENDING không được tự tạo lệnh thay thế. Mẫu này giữ chỗ PENDING và chưa cung cấp API đối soát hoặc lưu bền; hệ thống thực tế cần lưu payment/idempotency xuống cơ sở dữ liệu và có webhook hoặc truy vấn giao dịch để đối soát. Restart ngân hàng làm mất cả lịch sử idempotency, vì vậy không restart giữa một lệnh đang retry. Những phần mở rộng này không phải yêu cầu nộp của đề.

Nguồn tham khảo kỹ thuật: [Node.js HTTP Agent và ClientRequest](https://nodejs.org/docs/latest-v18.x/api/http.html), [Express 4 API](https://expressjs.com/en/4x/api.html). Chú ý: timeout socket không tự abort request; code dùng timer tổng và `req.destroy()`.

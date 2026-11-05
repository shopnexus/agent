# Chính sách thanh toán ShopNexus

**Mã tài liệu:** `POLICY-PAY-01`
**Phiên bản:** `1.1.0`
**Ngày hiệu lực:** `01/01/2026`

## 1. Hình thức thanh toán duy nhất

- Giao dịch trong ứng dụng chỉ được thực hiện bằng **giao hàng thu tiền hộ có đồng kiểm (COD đồng kiểm)**.
- Hệ thống **không có cổng thanh toán trực tuyến, ví điện tử, số dư hay tài khoản ký quỹ**. Sàn không đóng vai trò trung gian tài chính.
- Không áp dụng thanh toán bằng thẻ ngân hàng, thẻ quốc tế hoặc ví điện tử trên nền tảng.

## 2. Quy trình thanh toán

1. Người mua và người bán thương lượng giá qua tính năng trò chuyện; khi hai bên xác nhận thỏa thuận, đơn COD được tạo. Đơn không qua bước thanh toán trên sàn.
2. Hàng được giao qua hãng vận chuyển (GHN/GHTK) trên **tài khoản của chính người bán**.
3. Khi nhận hàng, người mua **mở kiện kiểm tra cùng shipper (đồng kiểm)**.
4. Nếu hàng đúng mô tả, người mua **thanh toán trực tiếp cho shipper**.
5. Hãng vận chuyển chuyển tiền thu hộ **thẳng vào tài khoản ngân hàng người bán** đã đăng ký với hãng, theo kỳ đối soát của hãng.

## 3. Phí vận chuyển

- Vận đơn được đặt ở chế độ **người nhận trả phí ship**.
- Khi người mua từ chối nhận hàng, hãng vận chuyển tính phí cả chiều đi lẫn chiều về cho người gửi.
- Phí ship thực tế được lấy từ hãng vận chuyển (giai đoạn 2). Ở giai đoạn 1, người bán tự nhập phí ship vào hệ thống.

## 4. Từ chối nhận hàng

- Nếu hàng không đúng như mô tả, người mua có quyền từ chối nhận; shipper mang hàng về trả người bán.
- Không có khoản tiền nào cần hoàn qua sàn; hệ thống **không thực hiện hoàn tiền**.
- Sự kiện từ chối nhận hàng do hãng xác nhận được ghi vào thống kê uy tín, và có thể dẫn đến chế tài theo tỷ lệ từ chối (ngưỡng cụ thể: `[chờ chốt]`).

## 5. Dữ liệu hệ thống lưu trữ

- Hệ thống **chỉ lưu thông tin đơn hàng và trạng thái giao nhận** (lấy hàng, đang giao, giao thành công, từ chối nhận).
- Hệ thống không thu thập hoặc lưu trữ số thẻ, mã CVV/CVC, thông tin ví điện tử của người dùng.
- Mỗi lời gọi tới hãng vận chuyển là một bước của workflow có ghi nhận kết quả; thao tác quan trọng mang idempotency key, nên việc bấm lặp hoặc thử lại **không tạo vận đơn hay đơn hàng trùng**.

## 6. Giới hạn

- Sau khi người mua đã thanh toán cho shipper, không còn bên thứ ba nào giữ tiền để hoàn lại nếu phát sinh sự cố về sau.
- Rủi ro còn lại được giảm thiểu bằng đồng kiểm trước khi trả tiền, ghi nhận sự cố công khai và hệ thống đánh giá uy tín.

> **Giai đoạn 1:** đơn COD hỗ trợ theo hình thức tự gửi (người bán nhập hãng, mã vận đơn, phí ship). Kết nối API GHTK/GHN, tự động báo phí, tạo vận đơn và nhận webhook thuộc giai đoạn 2.
# Chính sách bảo vệ người mua (ShopNexus SafeGuard)

**Mã tài liệu:** `POLICY-SAFEGUARD-01`
**Phiên bản:** `1.1.0`
**Ngày hiệu lực:** `01/01/2026`

## 1. Nguyên tắc nền tảng

ShopNexus là sàn C2C dành cho hàng đã qua sử dụng, vận hành theo hai ràng buộc:

- **Sàn không giữ tiền của người dùng.** Hệ thống không có ví, số dư hay cổng thanh toán.
- **Sàn không phân xử thủ công từng vụ việc.** Rủi ro được kiểm soát bằng quy trình giao dịch và thống kê hành vi khách quan.

## 2. Giao hàng thu tiền hộ có đồng kiểm (COD đồng kiểm)

- COD đồng kiểm là hình thức giao dịch duy nhất trong ứng dụng.
- Người mua **kiểm tra hàng cùng nhân viên giao hàng trước khi thanh toán**.
- Người mua trả tiền trực tiếp cho shipper. Hãng vận chuyển chuyển tiền thu hộ thẳng vào tài khoản ngân hàng người bán đã đăng ký với hãng.
- Vận đơn được tạo trên **tài khoản GHN/GHTK của chính người bán**, đặt chế độ người nhận trả phí ship.
- Hệ thống chỉ lưu thông tin đơn và trạng thái giao nhận do hãng báo về.

### Khi người mua từ chối nhận hàng

1. Hàng được shipper mang về và trả lại người bán.
2. Hãng vận chuyển tính phí cả chiều đi và chiều về cho người gửi.
3. Không có khoản tiền nào cần hoàn qua sàn; hệ thống **không thực hiện hoàn tiền**.
4. Sự kiện từ chối nhận được ghi nhận vào thống kê uy tín của người mua.

> **Giai đoạn 1:** đơn COD hỗ trợ theo hình thức **tự gửi**. Người bán mang hàng ra hãng vận chuyển, rồi nhập tên hãng, mã vận đơn và phí ship vào hệ thống. Kết nối API trực tiếp với GHTK/GHN thuộc giai đoạn 2.

## 3. Minh bạch thông tin hàng hóa

- Tình trạng hàng được khai báo theo thang ba mức: **Mới**, **Như mới**, **Đã dùng**.
- Người bán **bắt buộc khai báo khuyết điểm kèm ảnh chụp cận cảnh** trước khi đăng tin.
- Ảnh được chuẩn hóa kích thước và xóa metadata có thể tiết lộ vị trí.
- Các khuyết điểm do AI nhận diện phải được người bán xác nhận, khai báo kèm ảnh hoặc bác bỏ trước khi đăng.
- Người mua và người bán thương lượng giá qua tính năng trò chuyện trong ứng dụng, nên các cam kết được lưu vết trong hệ thống.

## 4. Hệ thống uy tín và chế tài tự động

- **Đánh giá** 1–5 sao sau mỗi giao dịch.
- **Ghi nhận sự cố công khai**, kèm nhận xét trung lập do AI tóm tắt.
- **Điểm uy tín** được tính tự động từ thống kê các sự kiện giao nhận thực tế do hãng vận chuyển xác nhận.
- **Quyền sử dụng** của người dùng được điều chỉnh tự động theo tỷ lệ từ chối nhận hàng (ngưỡng cụ thể: `[chờ chốt]`).
- Tài khoản có thể được xác minh danh tính điện tử (eKYC) bằng CCCD gắn chip và khuôn mặt (giai đoạn 3).

## 5. Báo cáo vi phạm

- Người dùng có thể báo cáo tin đăng hoặc tài khoản vi phạm: **hàng cấm, hàng giả, gian lận**.
- Điều phối viên tiếp nhận, xử lý theo phân quyền (khóa hoặc mở quyền) và ghi nhật ký kiểm toán.
- Điều phối viên xử lý **vi phạm quy định nền tảng**, không phân xử tranh chấp về chất lượng sản phẩm hay giá cả giữa hai bên.

## 6. Giới hạn của chính sách

- Sau khi người mua đã thanh toán cho shipper, không còn bên thứ ba nào giữ tiền để hoàn lại nếu phát sinh sự cố về sau.
- Rủi ro còn lại được giảm thiểu bằng việc đồng kiểm trước khi trả tiền, ghi nhận sự cố công khai và hệ thống uy tín.
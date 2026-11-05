# Chính sách từ chối nhận hàng và hoàn hàng ShopNexus

**Mã tài liệu:** `POLICY-RETURN-01`
**Phiên bản:** `1.3.0`
**Ngày hiệu lực:** `01/01/2026`

## 1. Nguyên tắc chung

- ShopNexus là sàn C2C dành cho hàng đã qua sử dụng, giao dịch duy nhất bằng **COD đồng kiểm**.
- Người mua **kiểm tra hàng cùng shipper ngay khi nhận** và chỉ thanh toán sau khi kiểm tra. Quyền từ chối được thực hiện **tại thời điểm giao hàng**.
- Sàn **không giữ tiền, không hoàn tiền và không phân xử thủ công** từng vụ việc.
- Hệ thống không có cơ chế yêu cầu trả hàng sau khi người mua đã thanh toán cho shipper `[chờ chốt: có hỗ trợ hay không]`.

## 2. Thời điểm và căn cứ từ chối nhận

- Người mua được **mở kiện, kiểm tra hàng trước khi thanh toán**.
- Người mua có quyền từ chối nhận nếu hàng **không đúng như mô tả** trong tin đăng, bao gồm:
  - Tình trạng không khớp mức đã khai báo (Mới, Như mới, Đã dùng).
  - Có khuyết điểm không được người bán khai báo kèm ảnh cận cảnh.
  - Giao sai sản phẩm hoặc thiếu phụ kiện đã nêu trong tin đăng.
- Các khuyết điểm **đã được khai báo kèm ảnh** trong tin đăng không phải căn cứ hợp lệ để từ chối.

## 3. Quy trình khi người mua từ chối nhận

1. Người mua từ chối nhận và không thanh toán cho shipper.
2. Shipper mang hàng về và trả lại **người bán**.
3. Hãng vận chuyển báo trạng thái **"từ chối nhận"** về hệ thống qua webhook (giai đoạn 2); ở giai đoạn 1, trạng thái do người bán cập nhật với đơn tự gửi.
4. Sự kiện được ghi nhận vào thống kê uy tín của người mua và phát sự kiện cho các phân hệ liên quan.

## 4. Phí vận chuyển

- Vận đơn được tạo trên tài khoản của người bán, đặt chế độ **người nhận trả phí ship**.
- Khi người mua từ chối nhận, hãng tính **phí cả chiều đi lẫn chiều về cho người gửi (người bán)**.
- Hệ thống không thu hộ hay hoàn phí ship; việc này do hãng vận chuyển xử lý.

## 5. Không có hoàn tiền qua sàn

- Vì người mua chỉ trả tiền sau khi kiểm tra hàng nên khi từ chối nhận **không có khoản tiền nào cần hoàn**.
- Hệ thống không có ví, số dư hoặc tài khoản ký quỹ nên không thực hiện hoàn tiền.
- Sau khi người mua đã thanh toán cho shipper, không còn bên thứ ba nào giữ tiền để hoàn lại nếu phát sinh sự cố về sau.

## 6. Chế tài và uy tín

- Hệ thống tự động tính **tỷ lệ từ chối nhận hàng** của mỗi người dùng từ sự kiện giao nhận do hãng xác nhận.
- Quyền sử dụng của người dùng được điều chỉnh tự động theo tỷ lệ này (ngưỡng cụ thể: `[chờ chốt]`).
- Người mua có thể để lại **đánh giá 1–5 sao**; sự cố được ghi nhận công khai kèm nhận xét trung lập do AI tóm tắt.
- Người dùng có thể **báo cáo vi phạm** (hàng cấm, hàng giả, gian lận) để điều phối viên xử lý; điều phối viên không phân xử tranh chấp về chất lượng hay giá cả giữa hai bên.

## 7. Bằng chứng và lưu vết

- Thương lượng và cam kết giữa hai bên được lưu vết trong tính năng trò chuyện theo từng tin đăng.
- Mô tả, ảnh và khuyết điểm khai báo trong tin đăng là căn cứ đối chiếu khi đồng kiểm.
- Video quay quá trình mở hộp là khuyến nghị của sàn, không phải điều kiện bắt buộc `[chờ chốt]`.

> **Giai đoạn 1:** đơn COD hỗ trợ theo hình thức tự gửi (người bán nhập hãng, mã vận đơn, phí ship). Kết nối API GHTK/GHN và webhook trạng thái thuộc giai đoạn 2.
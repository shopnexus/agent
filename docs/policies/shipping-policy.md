# Chính sách vận chuyển và giao nhận ShopNexus

**Mã tài liệu:** `POLICY-SHIP-01`
**Phiên bản:** `1.2.0`
**Ngày hiệu lực:** `01/01/2026`

## 1. Nguyên tắc chung

- ShopNexus **không trực tiếp vận chuyển hàng**. Việc giao nhận do hãng vận chuyển (**GHN, GHTK**) thực hiện.
- Vận đơn được tạo trên **tài khoản hãng của chính người bán**; hệ thống chỉ gửi lệnh tạo/hủy vận đơn và nhận trạng thái giao nhận do hãng báo về.
- Hình thức giao hàng duy nhất là **COD đồng kiểm**. Sàn không giữ tiền và không có ví hay cổng thanh toán.

## 2. Các giai đoạn triển khai

| Giai đoạn | Hình thức vận chuyển |
|---|---|
| Giai đoạn 1 | **Đơn tự gửi**: người bán mang hàng ra hãng vận chuyển, sau đó nhập tên hãng, mã vận đơn và phí ship vào hệ thống. |
| Giai đoạn 2 | **Tích hợp API GHTK/GHN**: kết nối tài khoản hãng của người bán, báo phí thực tế, tạo/hủy vận đơn tự động, nhận webhook trạng thái. |

## 3. Thời gian giao hàng

- Thời gian giao hàng **do hãng vận chuyển quyết định**; ShopNexus không cam kết ETA và không cung cấp dịch vụ giao hỏa tốc riêng.
- Ngưỡng hiển thị thời gian dự kiến cho người dùng (nếu có): `[chờ chốt]`.

## 4. Phí vận chuyển

- Phí ship là **phí thực tế do hãng báo** (giai đoạn 2); ở giai đoạn 1, người bán tự nhập phí ship.
- Vận đơn đặt chế độ **người nhận trả phí ship**.
- Hệ thống không áp dụng biểu phí cố định và không có chương trình miễn phí vận chuyển do sàn tài trợ.
- Khi người mua từ chối nhận hàng, hãng tính **phí cả chiều đi lẫn chiều về cho người gửi**.

## 5. Trạng thái giao nhận

Hệ thống ghi nhận các trạng thái do hãng báo về:

1. Lấy hàng
2. Đang giao
3. Giao thành công
4. Từ chối nhận

Mỗi thay đổi trạng thái đơn đồng thời phát sự kiện cho các phân hệ tin đăng, thông báo và uy tín.

## 6. Đồng kiểm khi nhận hàng

- Người mua được **mở kiện và kiểm tra hàng cùng shipper trước khi thanh toán**.
- Nếu hàng đúng như mô tả, người mua thanh toán trực tiếp cho shipper; hãng chuyển tiền thu hộ thẳng vào tài khoản ngân hàng của người bán.
- Nếu hàng không đúng mô tả, người mua có quyền **từ chối nhận**; shipper mang hàng về trả người bán và không có khoản tiền nào cần hoàn qua sàn.
- Phạm vi kiểm tra (ví dụ: có được bật nguồn, thử sản phẩm hay không): `[chờ chốt]`, tùy quy định của từng hãng.

## 7. Độ tin cậy của quy trình

- Mỗi lời gọi tới hãng vận chuyển là một bước của workflow có ghi nhận kết quả, nên việc thử lại **không tạo hai vận đơn**.
- Thao tác quan trọng mang idempotency key; bấm lặp hoặc gửi lại do mạng chập chờn nhận kết quả của lần đầu.
- Quy trình nhiều bước được lưu tiến độ và chạy tiếp được khi máy chủ hoặc mạng bị gián đoạn.
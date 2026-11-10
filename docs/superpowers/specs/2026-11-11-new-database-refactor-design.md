# Refactor sang database mới

## Mục tiêu và nguồn chuẩn

Chuyển toàn bộ runtime sang schema trong `docker/init-db/01-init-schema.sql` và cách ghép context trong `docs/context.md`. Người dùng xác nhận đây là database mới; không chuyển dữ liệu cũ, không duy trì schema hay API tương thích cũ.

Giữ NestJS, Strands SDK, LiteLLM, Prisma, MCP và các guardrail hiện có. Không đổi nhà cung cấp model. Không reset database, xoá volume hay chạy dịch vụ/model thật nếu chưa có yêu cầu riêng.

## Các hướng thực hiện

- Refactor trực tiếp toàn bộ các lớp: một mô hình dữ liệu duy nhất, loại bỏ đường chạy cũ. Đây là hướng đề xuất phù hợp yêu cầu bỏ phần cũ.
- Adapter tương thích hoặc dual-write: tăng code và duy trì hai mô hình; loại vì người dùng yêu cầu database mới, không cần tương thích.

## Phạm vi

### Database và Prisma

Map đúng actors, conversations, turns, messages, message_blocks, tool_calls, retrieval cùng enum, quan hệ, kiểu BIGINT và thứ tự trong SQL. SQL bootstrap là nguồn chuẩn cho constraint và index đặc thù PostgreSQL; không tạo một schema khác bằng Prisma db push. Đồng bộ migration baseline cho database mới; bỏ migration chỉ áp dụng cho schema cũ sau khi đọc nội dung. Không thực thi migration hoặc thao tác dữ liệu trong đợt sửa code.

### Conversation và API

Thay SessionRepository/SessionService bằng ConversationRepository/ConversationService. API dùng POST/GET /conversations và POST /chat với conversationId; kết quả trả actorId, conversationId, answer. Không giữ /sessions hoặc sessionId alias. Cập nhật CLI, demo, mock webview, test, audit metadata và tài liệu đang hướng dẫn sử dụng.

Actor luôn lấy từ gateway identity hoặc identity tin cậy của CLI; không lấy actor từ model arguments. Chỉ chủ conversation được đọc/ghi. Conversation archived/closed không nhận lượt chat mới. Context listing/page là dữ liệu từng request, không thêm cột context vào schema.

### Vòng đời lượt chạy

Luồng: xác thực actor/conversation → kiểm tra đầu vào và rate limit → tạo RUNNING turn cùng USER/TEXT một lần → dựng lịch sử từ các turn trước → scope assessment → agent/tool loop → xác minh output → lưu terminal answer và trạng thái cuối.

Dùng khoá/transaction PostgreSQL để cấp ordinal an toàn; unique index one-unfinished là hàng rào cuối. Yêu cầu cạnh tranh trên cùng conversation trả conflict, không chạy song song hoặc xếp hàng ngầm. Không giữ transaction mở trong khi gọi model/tool.

Greeting, refusal và clarification có câu trả lời cuối vẫn là lượt SUCCEEDED khi xử lý hoàn tất. Lỗi model/tool không được khắc phục là FAILED; hết thời gian TIMED_OUT; huỷ là CANCELLED. Trả fallback đã kiểm soát nhưng không giả lập thành công. Luôn thiết lập finished_at và thời lượng cho trạng thái kết thúc. Giữ giới hạn lượt, kill switch và deadline hiện có. Trạng thái AWAITING_* được map đầy đủ nhưng không bổ sung workflow approval/resume mới.

Usage cộng từ metadata SDK khi có; không suy đoán số token. Chuyển BIGINT sang kiểu trả JSON an toàn ở boundary. Crash có thể để lại RUNNING turn; không tự cướp lượt đang chạy hoặc đánh dấu thành công. Ghi rõ giới hạn phục hồi crash, không tự triển khai lease/background recovery.

### Transcript và audit

Persist từng completed block bằng hook/middleware SDK thích hợp, không chờ đến cuối turn. Mỗi message có ordinal, mỗi block có ordinal và event_seq ổn định cho retry. USER chỉ chứa đầu vào. TOOL_USE/TOOL_RESULT được lưu dưới ASSISTANT envelope theo schema; adapter chuyển tool result thành định dạng user/tool-result mà SDK yêu cầu khi replay.

Không lưu raw chain-of-thought. Không expose tiến trình hoặc draft chưa kiểm duyệt ra HTTP/CLI. Draft final answer chỉ trở thành terminal TEXT sau khi qua verifier và scope review; rejected draft không được dùng làm câu trả lời lịch sử.

Audit tool và transcript được ghi nhất quán trong transaction khi cùng một sự kiện. Logical identity là (turn_id, tool_use_id), không cắt ID để tạo collision. Pending/running/success/failed/cancelled được map rõ từ SDK. Callback hoàn tất sau timeout có thể cập nhật audit/trạng thái tool nhưng không mở lại turn hoặc thay terminal answer. Giữ redaction, payload cap, output spill ownership và thông báo trung thực về memory side effect.

### Ghép short-term context

Chọn N turn trước theo conversation đã authorize, xếp turn/message/block theo ordinal. N và budget là cấu hình backend. Không dùng tool_calls làm transcript. Chỉ replay USER/TEXT, terminal ASSISTANT/TEXT và cặp tool đầy đủ trong cùng turn. Loại THINKING, progress narration, draft và tool orphan. Với turn lỗi/huỷ/timeout, thể hiện trạng thái chưa hoàn tất thay vì coi action đã thành công. Bound output, giữ cấu trúc cặp và marker truncation. Đầu vào hiện tại được append đúng một lần.

### Retrieval và memory

Thay UserMemory/MemoryRepository bằng model/repository retrieval duy nhất. STATEMENT có kind FACT/PREFERENCE/SUMMARY; EXCERPT có document_id/chunk_index và citation metadata. Không thêm lại category/fact_key vì schema mới không có các cột đó.

Giữ memory_search/save/supersede dưới quyền scope hiện có nhưng đổi contract: save nhận kind và content cho một fact độc lập; supersede nhắm exact current retrieval ID đã search, giữ actor và loại dữ liệu, lưu phiên bản cũ. Không hứa đảm bảo unique property bằng fact_key đã bị bỏ. Không tự thay thế fact khi save. Giữ kiểm tra PII/secret/transient commerce và actor-bound tool closures. Điều chỉnh prompt và test để không còn yêu cầu category/factKey.

Dùng search tool được authorize để lấy context theo nhu cầu thay vì tự inject mọi memory ở đầu turn. Query có nghĩa dựa câu hỏi và lịch sử gần; filter actor cùng superseded/deleted/expiry trước chọn ứng viên; hybrid semantic + FTS và literal/trigram khi phù hợp; fusion/ranking và budget kết quả. Cùng model embedding 1024 chiều cho write/read; reject vector sai chiều, NaN/Infinity và zero vector. Retrieved content là dữ liệu không tin cậy.

Cung cấp service ingestion cho văn bản tài liệu: chunk trước embedding, document ID ổn định, metadata trích dẫn và origin EXCERPT. Không thêm upload API, binary storage, OCR hay registry tài liệu. Search hỗ trợ lọc STATEMENT/EXCERPT hoặc cả hai; kết quả EXCERPT giữ citation metadata. Công cụ tìm kiếm có tên memory_search vẫn có thể trả context tài liệu thuộc actor khi scope cho phép, với origin rõ ràng và không công bố nguồn không có thật.

### Dọn code và tài liệu

Bỏ model, repository, helper, config và test chỉ phục vụ sessions/user_memories/JSON transcript cũ; cập nhật test bảo vệ hành vi tương đương trên schema mới thay vì chỉ xoá assertion. Kiểm tra registry/counter công cụ không còn được dùng rồi loại bỏ. Giữ mock MCP commerce và guardrail cần thiết. Sửa các tham chiếu UI cũ nếu nằm trong đường chạy đã cập nhật. Không chỉnh các thay đổi sẵn có không liên quan. Tài liệu lịch sử có thể giữ khi được ghi rõ là lịch sử, không được là hướng dẫn runtime hiện tại.

## Kiểm chứng

Prisma validate/generate, TypeScript build và toàn bộ test offline liên quan. Thêm test lifecycle/ordinal/concurrency conflict, replay ordered blocks, tool pairing, idempotency, late events, isolation, retrieval filters, origin/kind, citation và vector validation. Thêm integration test PostgreSQL có opt-in để kiểm tra schema thật, constraint/index, transaction và hybrid search; không tự chạy nếu chưa có database test được cấp. Không dùng mock pass để tuyên bố đã kiểm chứng PostgreSQL thật. Báo rõ bước chưa chạy và lỗi còn lại.

## Quyết định giao người triển khai

Tên file và cách tách service/adapter; kích thước chunk và budget mặc định có cấu hình; vị trí gắn hook theo SDK đang cài. Không thêm dependency nếu thư viện hiện có đủ. Không commit/push nếu người dùng chưa yêu cầu.

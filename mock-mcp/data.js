// Mock E-Commerce Database for ShopNexus
const products = [
  {
    id: 'PROD-001',
    name: 'Áo Thun Unisex Cotton Compact 100% Premium',
    category: 'Thời trang',
    price: 199000,
    originalPrice: 250000,
    stock: 120,
    rating: 4.8,
    reviewCount: 342,
    description: 'Chất liệu cotton compact co giãn 4 chiều, thoáng khí, không xù lông sau khi giặt. Form suông rộng hiện đại.',
    variants: [
      { sku: 'AT-WHT-M', color: 'Trắng', size: 'M', stock: 40 },
      { sku: 'AT-WHT-L', color: 'Trắng', size: 'L', stock: 35 },
      { sku: 'AT-BLK-M', color: 'Đen', size: 'M', stock: 25 },
      { sku: 'AT-BLK-L', color: 'Đen', size: 'L', stock: 20 }
    ],
    sellerId: 'SHOP-888',
    status: 'ACTIVE'
  },
  {
    id: 'PROD-002',
    name: 'Giày Thể Thao Running Pro Max Đệm Khí Êm Ái',
    category: 'Giày dép',
    price: 850000,
    originalPrice: 1100000,
    stock: 45,
    rating: 4.9,
    reviewCount: 128,
    description: 'Đế đệm khí êm chân, trọng lượng siêu nhẹ 210g, thích hợp chạy bộ và tập gym hàng ngày.',
    variants: [
      { sku: 'GTT-GRY-41', color: 'Xám', size: '41', stock: 15 },
      { sku: 'GTT-GRY-42', color: 'Xám', size: '42', stock: 20 },
      { sku: 'GTT-BLK-42', color: 'Đen', size: '42', stock: 10 }
    ],
    sellerId: 'SHOP-888',
    status: 'ACTIVE'
  },
  {
    id: 'PROD-003',
    name: 'Tai Nghe Bluetooth True Wireless Chống Ồn ANC Gen 3',
    category: 'Điện tử',
    price: 1250000,
    originalPrice: 1590000,
    stock: 30,
    rating: 4.7,
    reviewCount: 95,
    description: 'Chống ồn chủ động ANC lên đến 38dB, thời lượng pin 32 giờ kèm hộp sạc, chống nước IPX5.',
    variants: [
      { sku: 'TN-WHT', color: 'Trắng Ngọc Trai', stock: 18 },
      { sku: 'TN-BLK', color: 'Đen Mờ', stock: 12 }
    ],
    sellerId: 'SHOP-999',
    status: 'ACTIVE'
  },
  {
    id: 'PROD-004',
    name: 'Bàn Phím Cơ Không Dây Tri-Mode 75% Hotswap Gasket Mount',
    category: 'Phụ kiện máy tính',
    price: 1490000,
    originalPrice: 1800000,
    stock: 15,
    rating: 4.9,
    reviewCount: 76,
    description: 'Hỗ trợ 3 chế độ kết nối: Type-C, Bluetooth 5.1 và 2.4Ghz. Cấu trúc Gasket mount gõ êm tai, switch linear mượt mà.',
    variants: [
      { sku: 'KB-RED-SW', switch: 'Red Switch Linear', stock: 9 },
      { sku: 'KB-BRN-SW', switch: 'Brown Switch Tactile', stock: 6 }
    ],
    sellerId: 'SHOP-999',
    status: 'ACTIVE'
  },
  {
    id: 'PROD-005',
    name: 'Cáp Sạc Nhanh Type-C to Type-C 100W Bọc Dù Siêu Bền',
    category: 'Phụ kiện điện tử',
    price: 1200000,
    originalPrice: 160000,
    stock: 300,
    rating: 4.6,
    reviewCount: 520,
    description: 'Hỗ trợ chuẩn PD 3.0 sạc nhanh tối đa 100W cho laptop và smartphone. Chiều dài 1.5m bọc sợi nylon chịu uốn gập.',
    variants: [
      { sku: 'CAB-1.5M', length: '1.5m', stock: 200 },
      { sku: 'CAB-2.0M', length: '2.0m', stock: 100 }
    ],
    sellerId: 'SHOP-888',
    status: 'ACTIVE'
  },
  {
    id: 'PROD-006',
    name: 'Bình Giữ Nhiệt Inox 316 Cao Cấp 800ml Kèm Ống Hút',
    category: 'Gia dụng',
    price: 260000,
    originalPrice: 320000,
    stock: 80,
    rating: 4.8,
    reviewCount: 215,
    description: 'Chất liệu inox 316 an toàn cho sức khỏe, giữ nhiệt nóng 12h, giữ lạnh 24h. Nắp bấm tiện lợi.',
    variants: [
      { sku: 'BGN-SLV', color: 'Bạc Inox', stock: 45 },
      { sku: 'BGN-GRN', color: 'Xanh Matcha', stock: 35 }
    ],
    sellerId: 'SHOP-888',
    status: 'ACTIVE'
  }
];

const orders = [
  {
    id: 'ORD-1001',
    customerId: 'CUST-001',
    customerName: 'Nguyễn Văn A',
    customerPhone: '0901234567',
    status: 'DELIVERED',
    items: [
      { productId: 'PROD-001', name: 'Áo Thun Unisex Cotton Compact', sku: 'AT-WHT-L', quantity: 2, unitPrice: 199000 },
      { productId: 'PROD-005', name: 'Cáp Sạc Nhanh Type-C 100W', sku: 'CAB-1.5M', quantity: 1, unitPrice: 120000 }
    ],
    subtotal: 518000,
    shippingFee: 25000,
    discount: 25000,
    totalAmount: 518000,
    paymentMethod: 'COD',
    paymentStatus: 'PAID',
    shippingAddress: 'Tòa nhà Landmark 81, 720A Điện Biên Phủ, Phường 22, Bình Thạnh, TP. Hồ Chí Minh',
    carrier: 'Giao Hàng Tiết Kiệm (GHTK)',
    trackingNumber: 'GHTK-98234120',
    createdAt: '2026-10-12T09:30:00Z',
    deliveredAt: '2026-10-14T14:15:00Z'
  },
  {
    id: 'ORD-1002',
    customerId: 'CUST-001',
    customerName: 'Nguyễn Văn A',
    customerPhone: '0901234567',
    status: 'SHIPPING',
    items: [
      { productId: 'PROD-003', name: 'Tai Nghe Bluetooth True Wireless ANC Gen 3', sku: 'TN-WHT', quantity: 1, unitPrice: 1250000 }
    ],
    subtotal: 1250000,
    shippingFee: 30000,
    discount: 50000,
    totalAmount: 1230000,
    paymentMethod: 'VNPAY',
    paymentStatus: 'PAID',
    shippingAddress: 'Tòa nhà Landmark 81, 720A Điện Biên Phủ, Phường 22, Bình Thạnh, TP. Hồ Chí Minh',
    carrier: 'Shopee Xpress (SPX)',
    trackingNumber: 'SPXVN039281729',
    createdAt: '2026-10-15T11:20:00Z',
    estimatedDeliveryDate: '2026-10-18T18:00:00Z'
  },
  {
    id: 'ORD-1003',
    customerId: 'CUST-002',
    customerName: 'Trần Thị B',
    customerPhone: '0987654321',
    status: 'PROCESSING',
    items: [
      { productId: 'PROD-004', name: 'Bàn Phím Cơ Không Dây Tri-Mode 75%', sku: 'KB-RED-SW', quantity: 1, unitPrice: 1490000 }
    ],
    subtotal: 1490000,
    shippingFee: 0,
    discount: 100000,
    totalAmount: 1390000,
    paymentMethod: 'MOMO',
    paymentStatus: 'PAID',
    shippingAddress: '123 Đường Cầu Giấy, Quận Cầu Giấy, Hà Nội',
    carrier: 'Viettel Post',
    trackingNumber: 'VTP-88419203',
    createdAt: '2026-10-16T15:45:00Z'
  },
  {
    id: 'ORD-1004',
    customerId: 'CUST-003',
    customerName: 'Lê Hoàng C',
    customerPhone: '0912348899',
    status: 'CANCELLED',
    items: [
      { productId: 'PROD-002', name: 'Giày Thể Thao Running Pro Max', sku: 'GTT-GRY-42', quantity: 1, unitPrice: 850000 }
    ],
    subtotal: 850000,
    shippingFee: 35000,
    discount: 0,
    totalAmount: 885000,
    paymentMethod: 'COD',
    paymentStatus: 'UNPAID',
    shippingAddress: '45 Lê Duẩn, Quận Hải Châu, TP. Đà Nẵng',
    cancelReason: 'Khách hàng đổi ý muốn chọn màu đen',
    createdAt: '2026-10-10T08:10:00Z',
    cancelledAt: '2026-10-10T09:00:00Z'
  }
];

const shipments = {
  'GHTK-98234120': {
    trackingNumber: 'GHTK-98234120',
    carrier: 'Giao Hàng Tiết Kiệm',
    orderId: 'ORD-1001',
    status: 'DELIVERED',
    statusText: 'Đã giao hàng thành công',
    timeline: [
      { time: '2026-10-12 10:00', text: 'Shop đã chuẩn bị hàng và bàn giao cho bưu tá' },
      { time: '2026-10-12 18:30', text: 'Bưu phẩm nhập kho trung chuyển Tân Bình' },
      { time: '2026-10-13 08:45', text: 'Rời kho trung chuyển, hướng tới bưu cục Bình Thạnh' },
      { time: '2026-10-14 09:10', text: 'Shipper đang trên đường giao hàng đến địa chỉ nhận' },
      { time: '2026-10-14 14:15', text: 'Đã giao hàng thành công, ký nhận bởi: Nguyễn Văn A' }
    ]
  },
  'SPXVN039281729': {
    trackingNumber: 'SPXVN039281729',
    carrier: 'Shopee Xpress (SPX)',
    orderId: 'ORD-1002',
    status: 'IN_TRANSIT',
    statusText: 'Đang vận chuyển qua kho tổng Củ Chi SOC',
    timeline: [
      { time: '2026-10-15 13:00', text: 'Đơn hàng đã được người bán gửi tại bưu cục' },
      { time: '2026-10-15 22:15', text: 'Đã đến trung tâm phân loại Củ Chi SOC' },
      { time: '2026-10-16 06:30', text: 'Đang luân chuyển tới bưu cục giao phát khu vực' }
    ]
  },
  'VTP-88419203': {
    trackingNumber: 'VTP-88419203',
    carrier: 'Viettel Post',
    orderId: 'ORD-1003',
    status: 'PICKING_UP',
    statusText: 'Chờ shipper đến lấy hàng tại kho người bán',
    timeline: [
      { time: '2026-10-16 16:00', text: 'Đã tạo mã vận đơn thành công, gửi yêu cầu lấy hàng' }
    ]
  }
};

const sellerAnalytics = {
  sellerId: 'SHOP-888',
  storeName: 'ShopNexus Official Store',
  period: 'Last 30 Days',
  summary: {
    totalRevenue: 58450000,
    totalOrders: 215,
    successfulOrders: 198,
    cancelledOrders: 8,
    returnRate: '1.8%',
    averageOrderValue: 271860,
    ratingAverage: 4.85
  },
  topSellingProducts: [
    { productId: 'PROD-001', name: 'Áo Thun Unisex Cotton Compact', soldCount: 94, revenue: 18706000 },
    { productId: 'PROD-005', name: 'Cáp Sạc Nhanh Type-C 100W', soldCount: 88, revenue: 10560000 },
    { productId: 'PROD-002', name: 'Giày Sneaker Running Pro Max', soldCount: 32, revenue: 27200000 }
  ]
};

const inventory = [
  {
    productId: 'PROD-001',
    warehouses: [
      { warehouseName: 'Kho Tổng TP.HCM (Tân Bình)', stock: 80, available: 75, reserved: 5 },
      { warehouseName: 'Kho Miền Bắc (Hà Nội - Long Biên)', stock: 40, available: 40, reserved: 0 }
    ]
  },
  {
    productId: 'PROD-003',
    warehouses: [
      { warehouseName: 'Kho Tổng TP.HCM (Tân Bình)', stock: 30, available: 28, reserved: 2 }
    ]
  },
  {
    productId: 'PROD-004',
    warehouses: [
      { warehouseName: 'Kho Miền Bắc (Hà Nội - Long Biên)', stock: 15, available: 12, reserved: 3 }
    ]
  }
];

module.exports = {
  products,
  orders,
  shipments,
  sellerAnalytics,
  inventory
};

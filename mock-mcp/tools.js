// ShopNexus MCP Tools Definition and Execution Handlers
const db = require('./data');

const toolsList = [
  {
    name: 'search_products',
    description: 'Tìm kiếm sản phẩm theo từ khóa (tên, mô tả), danh mục sản phẩm hoặc khoảng giá.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Từ khóa tìm kiếm (ví dụ: "áo thun", "tai nghe chống ồn", "giày sneaker")'
        },
        category: {
          type: 'string',
          description: 'Danh mục lọc (ví dụ: "Thời trang", "Điện tử", "Giày dép", "Gia dụng")'
        },
        minPrice: {
          type: 'number',
          description: 'Giá tối thiểu (VNĐ)'
        },
        maxPrice: {
          type: 'number',
          description: 'Giá tối đa (VNĐ)'
        },
        limit: {
          type: 'number',
          description: 'Số lượng sản phẩm tối đa trả về (mặc định: 5)'
        }
      }
    }
  },
  {
    name: 'get_product',
    description: 'Lấy thông tin chi tiết đầy đủ của sản phẩm theo mã sản phẩm (productId) hoặc SKU.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'Mã ID sản phẩm (ví dụ: "PROD-001", "PROD-002") hoặc mã SKU'
        }
      },
      required: ['productId']
    }
  },
  {
    name: 'get_order',
    description: 'Lấy thông tin chi tiết một đơn hàng: trạng thái thanh toán, địa chỉ, danh sách món hàng và mã vận đơn.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'Mã đơn hàng cần tra cứu (ví dụ: "ORD-1001", "ORD-1002")'
        }
      },
      required: ['orderId']
    }
  },
  {
    name: 'list_orders',
    description: 'Lấy danh sách các đơn hàng gần đây của khách hàng hoặc theo trạng thái đơn hàng.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: {
          type: 'string',
          description: 'Mã khách hàng (ví dụ: "CUST-001")'
        },
        status: {
          type: 'string',
          description: 'Lọc trạng thái: "PROCESSING", "SHIPPING", "DELIVERED", "CANCELLED"'
        },
        limit: {
          type: 'number',
          description: 'Số lượng đơn hàng tối đa trả về (mặc định: 5)'
        }
      }
    }
  },
  {
    name: 'get_shipping_status',
    description: 'Tra cứu hành trình vận chuyển chi tiết theo mã vận đơn (trackingNumber) hoặc mã đơn hàng (orderId).',
    inputSchema: {
      type: 'object',
      properties: {
        trackingNumber: {
          type: 'string',
          description: 'Mã vận đơn bưu cục (ví dụ: "GHTK-98234120", "SPXVN039281729")'
        },
        orderId: {
          type: 'string',
          description: 'Mã đơn hàng (ví dụ: "ORD-1001", "ORD-1002")'
        }
      }
    }
  },
  {
    name: 'check_inventory',
    description: 'Kiểm tra tồn kho thực tế, số lượng có thể bán và phân bổ kho bãi của một sản phẩm.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'Mã ID sản phẩm (ví dụ: "PROD-001")'
        }
      },
      required: ['productId']
    }
  },
  {
    name: 'cancel_order',
    description: 'Hủy đơn hàng nếu đơn hàng đang ở trạng thái chờ xử lý (PROCESSING).',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'Mã đơn hàng muốn hủy (ví dụ: "ORD-1003")'
        },
        reason: {
          type: 'string',
          description: 'Lý do hủy đơn hàng'
        }
      },
      required: ['orderId']
    }
  },
  {
    name: 'get_seller_analytics',
    description: 'Lấy báo cáo doanh thu, số lượng đơn hàng, tỷ lệ hủy/hoàn và top sản phẩm bán chạy cho Người bán (Seller).',
    inputSchema: {
      type: 'object',
      properties: {
        sellerId: {
          type: 'string',
          description: 'Mã người bán/shop (mặc định: "SHOP-888")'
        },
        period: {
          type: 'string',
          description: 'Kỳ báo cáo (ví dụ: "Last 7 Days", "Last 30 Days")'
        }
      }
    }
  }
];

function executeTool(name, args) {
  args = args || {};

  switch (name) {
    case 'search_products': {
      const { query, category, minPrice, maxPrice, limit = 5 } = args;
      let results = [...db.products];

      if (query) {
        const words = query.toLowerCase().trim().split(/\s+/).filter(w => w.length > 1);
        results = results.filter(p => {
          const text = `${p.name} ${p.description} ${p.category}`.toLowerCase();
          return words.some(w => text.includes(w));
        });
      }
      if (category) {
        const c = category.toLowerCase().trim();
        results = results.filter(p => p.category.toLowerCase().includes(c));
      }
      if (minPrice !== undefined) {
        results = results.filter(p => p.price >= minPrice);
      }
      if (maxPrice !== undefined) {
        results = results.filter(p => p.price <= maxPrice);
      }

      const sliced = results.slice(0, limit);
      return {
        totalMatches: results.length,
        returned: sliced.length,
        products: sliced.map(p => ({
          id: p.id,
          name: p.name,
          category: p.category,
          price: p.price,
          originalPrice: p.originalPrice,
          stock: p.stock,
          rating: p.rating,
          description: p.description
        }))
      };
    }

    case 'get_product': {
      const { productId } = args;
      if (!productId) {
        return { error: 'Thiếu tham số productId' };
      }
      const prod = db.products.find(p => 
        p.id.toLowerCase() === productId.toLowerCase() ||
        p.variants?.some(v => v.sku.toLowerCase() === productId.toLowerCase())
      );
      if (!prod) {
        return { notFound: true, message: `Không tìm thấy sản phẩm có mã "${productId}"` };
      }
      return prod;
    }

    case 'get_order': {
      const { orderId } = args;
      if (!orderId) {
        return { error: 'Thiếu tham số orderId' };
      }
      const order = db.orders.find(o => o.id.toLowerCase() === orderId.toLowerCase());
      if (!order) {
        return { notFound: true, message: `Không tìm thấy đơn hàng "${orderId}"` };
      }
      return order;
    }

    case 'list_orders': {
      const { customerId, status, limit = 5 } = args;
      let list = [...db.orders];

      if (customerId) {
        list = list.filter(o => o.customerId.toLowerCase() === customerId.toLowerCase());
      }
      if (status) {
        list = list.filter(o => o.status.toUpperCase() === status.toUpperCase());
      }

      return {
        total: list.length,
        orders: list.slice(0, limit)
      };
    }

    case 'get_shipping_status': {
      const { trackingNumber, orderId } = args;
      let shipment = null;

      if (trackingNumber) {
        shipment = db.shipments[trackingNumber] || Object.values(db.shipments).find(s => s.trackingNumber.toLowerCase() === trackingNumber.toLowerCase());
      } else if (orderId) {
        shipment = Object.values(db.shipments).find(s => s.orderId.toLowerCase() === orderId.toLowerCase());
      }

      if (!shipment) {
        return { notFound: true, message: 'Không tìm thấy thông tin vận đơn hoặc đơn hàng này chưa xuất kho.' };
      }
      return shipment;
    }

    case 'check_inventory': {
      const { productId } = args;
      const inv = db.inventory.find(i => i.productId.toLowerCase() === productId?.toLowerCase());
      const prod = db.products.find(p => p.id.toLowerCase() === productId?.toLowerCase());

      if (!prod) {
        return { notFound: true, message: `Không tìm thấy sản phẩm "${productId}" trong hệ thống kho.` };
      }

      return {
        productId: prod.id,
        productName: prod.name,
        totalStock: prod.stock,
        warehouses: inv ? inv.warehouses : [
          { warehouseName: 'Kho Trung Tâm', stock: prod.stock, available: prod.stock, reserved: 0 }
        ]
      };
    }

    case 'cancel_order': {
      const { orderId, reason } = args;
      const order = db.orders.find(o => o.id.toLowerCase() === orderId?.toLowerCase());
      if (!order) {
        return { success: false, message: `Không tìm thấy đơn hàng "${orderId}" để hủy.` };
      }
      if (order.status !== 'PROCESSING') {
        return {
          success: false,
          currentStatus: order.status,
          message: `Không thể hủy đơn hàng "${orderId}" vì đơn hàng đang ở trạng thái "${order.status}". Chỉ đơn hàng PROCESSING mới được hủy.`
        };
      }

      order.status = 'CANCELLED';
      order.cancelReason = reason || 'Người dùng yêu cầu hủy qua trợ lý ảo';
      order.cancelledAt = new Date().toISOString();

      return {
        success: true,
        message: `Đã hủy thành công đơn hàng ${orderId}.`,
        order
      };
    }

    case 'get_seller_analytics': {
      return db.sellerAnalytics;
    }

    default:
      throw new Error(`Tool không tồn tại: ${name}`);
  }
}

module.exports = {
  toolsList,
  executeTool
};

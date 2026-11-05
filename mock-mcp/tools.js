// ShopNexus MCP Tools Definition and Execution Handlers
const fs = require('fs');
const path = require('path');
const db = require('./data');

function searchPolicies(question) {
  if (!question) {
    return { answer: 'Vui lòng cung cấp câu hỏi cần tra cứu chính sách.', source: null, version: null };
  }
  const policyDir = path.join(__dirname, '..', 'docs', 'policies');
  if (!fs.existsSync(policyDir)) {
    return { answer: 'Kho tài liệu chính sách đang được cập nhật.', source: null, version: null };
  }

  const files = fs.readdirSync(policyDir).filter(f => f.endsWith('.md'));
  const qLower = question.toLowerCase();
  const qWords = qLower.split(/\s+/).filter(w => w.length > 1);

  let bestMatch = null;
  let maxScore = 0;

  for (const file of files) {
    const fullPath = path.join(policyDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const contentLower = content.toLowerCase();

    let score = 0;
    for (const word of qWords) {
      if (contentLower.includes(word)) score += 1;
    }
    if ((qLower.includes('đổi') || qLower.includes('trả') || qLower.includes('hoàn tiền')) && file.includes('return')) score += 5;
    if ((qLower.includes('ship') || qLower.includes('giao') || qLower.includes('vận chuyển') || qLower.includes('hỏa tốc')) && file.includes('shipping')) score += 5;
    if ((qLower.includes('bảo vệ') || qLower.includes('giả') || qLower.includes('tranh chấp') || qLower.includes('escrow')) && file.includes('buyer-protection')) score += 5;
    if ((qLower.includes('thanh toán') || qLower.includes('cod') || qLower.includes('thẻ') || qLower.includes('momo')) && file.includes('payment')) score += 5;

    if (score > maxScore) {
      maxScore = score;
      bestMatch = { file, content, score };
    }
  }

  if (bestMatch && maxScore >= 2) {
    return {
      answer: bestMatch.content,
      source: `docs/policies/${bestMatch.file}`,
      version: '1.0.0'
    };
  }

  return {
    answer: 'Không tìm thấy chính sách đã duyệt phù hợp với câu hỏi này.',
    source: null,
    version: null
  };
}

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
    name: 'get_policy',
    description: 'Tra cứu chính sách cửa hàng (đổi trả, vận chuyển, bảo hành, thanh toán, v.v.) theo câu hỏi.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Câu hỏi về chính sách cần tra cứu (ví dụ: "Chính sách đổi trả như thế nào?")'
        }
      },
      required: ['question']
    }
  },
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

    case 'get_policy': {
      const { question } = args;
      return searchPolicies(question);
    }

    default:
      throw new Error(`Tool không tồn tại: ${name}`);
  }
}

module.exports = {
  toolsList,
  executeTool
};

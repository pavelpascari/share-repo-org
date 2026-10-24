// Shared IDs and state for the Paddle contract suite: the fixtures under fixtures/paddle and the
// fake are built to agree on these.

export const PADDLE_API = "https://api.paddle.test";
export const PADDLE_KEY = `pdl_sdbx_apikey_${"a1".repeat(13)}_${"B2".repeat(11)}_C3d`;

export const SELLER = { id: "slr_01jseller00000000000000001", name: "Octo Creator Ltd" };
export const PRICE_MONTHLY = "pri_01jmonthly0000000000000001";
export const PRICE_YEARLY = "pri_01jyearly00000000000000001";
export const PRICE_STARTER = "pri_01jstarter0000000000000001";
export const PRODUCT_COURSE = "pro_01jcourse00000000000000001";
export const PRODUCT_STARTER = "pro_01jstarter0000000000000001";
export const CUSTOMER_JO = { id: "ctm_01jjo000000000000000000001", email: "jo@example.com" };
export const CUSTOMER_SAM = { id: "ctm_01jsam00000000000000000001", email: "sam@example.com" };
export const SUB_JO = "sub_01jcourse00000000000000001";
export const SUB_SAM = "sub_01jcourse00000000000000002";
export const UNKNOWN_SUB = "sub_01jcourse00000000000000099";
export const UNKNOWN_CUSTOMER = "ctm_01jnobody00000000000000099";
export const UNKNOWN_SETTING = "ntfset_01jnobody00000000000000099";
export const CLAIM_REFERENCE = "v1.ckc_fixture.mac";
export const PAYMENT_LINK = "https://octo.example/pay";
export const PERMISSIONS = [
  "product.read",
  "price.read",
  "customer.read",
  "subscription.read",
  "transaction.read",
  "transaction.write",
  "notification_setting.write",
];

export const T0 = "2026-10-01T09:00:00Z";
export const T1 = "2026-10-05T12:00:00Z";
export const NOW = "2026-10-06T00:00:00Z";

export const PRICES = [
  {
    id: PRICE_MONTHLY,
    productId: PRODUCT_COURSE,
    productName: "Course code",
    productDescription: "Source for the course",
    description: "Monthly",
    billingCycle: { interval: "month", frequency: 1 },
    unitAmount: "1500",
    currency: "USD",
    status: "active",
  },
  {
    id: PRICE_YEARLY,
    productId: PRODUCT_COURSE,
    productName: "Course code",
    productDescription: "Source for the course",
    description: "Yearly",
    billingCycle: { interval: "year", frequency: 1 },
    unitAmount: "15000",
    currency: "USD",
    status: "active",
  },
  {
    id: PRICE_STARTER,
    productId: PRODUCT_STARTER,
    productName: "Starter kit",
    productDescription: null,
    description: "One-time",
    billingCycle: null,
    unitAmount: "4900",
    currency: "USD",
    status: "archived",
  },
] as const;

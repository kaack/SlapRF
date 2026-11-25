//go:build cgo && (arm64 || amd64)

package gguf

/*
#cgo CFLAGS: -O3 -ffast-math
#include <stdint.h>
#include <string.h>

#if defined(__aarch64__) || defined(_M_ARM64)
#include <arm_neon.h>
#endif

typedef struct {
    float   d;
    int8_t  qs[256];
    int16_t bsums[16];
} slaprf_q8k_t;

static inline float slaprf_fp16_to_fp32(uint16_t h, const float *fp16_tbl) {
#if defined(__aarch64__) && defined(__clang__)
    __fp16 fh;
    memcpy(&fh, &h, 2);
    return (float)fh;
#else
    return fp16_tbl[h];
#endif
}

static inline void slaprf_scale_min_k4(int j, const uint8_t *q, uint8_t *d, uint8_t *m) {
    if (j < 4) {
        *d = q[j] & 63;
        *m = q[j + 4] & 63;
    } else {
        *d = (q[j + 4] & 0x0F) | ((q[j - 4] & 0xC0) >> 2);
        *m = (q[j + 4] >> 4)   | ((q[j]     & 0xC0) >> 2);
    }
}

#if defined(__aarch64__) && defined(__clang__)
#define SLAPRF_TARGET_DOTPROD __attribute__((target("dotprod")))
#else
#define SLAPRF_TARGET_DOTPROD
#endif

static SLAPRF_TARGET_DOTPROD float slaprf_dot_q4k_q8k(const uint8_t *w_row, int nb, const slaprf_q8k_t *x_blocks, const float *fp16_tbl) {
    float total = 0.0f;
    for (int b = 0; b < nb; ++b) {
        const uint8_t *blk = w_row + b * 144;
        uint16_t hd, hmin;
        memcpy(&hd, blk, 2);
        memcpy(&hmin, blk + 2, 2);
        const float d = slaprf_fp16_to_fp32(hd, fp16_tbl);
        const float dmin = slaprf_fp16_to_fp32(hmin, fp16_tbl);
        const uint8_t *scales = blk + 4;
        const uint8_t *qs = blk + 16;
        const slaprf_q8k_t *xb = &x_blocks[b];

        int32_t sum_q = 0;
        int32_t sum_m = 0;

        for (int is = 0; is < 8; is += 2) {
            uint8_t sc1, m1, sc2, m2;
            slaprf_scale_min_k4(is, scales, &sc1, &m1);
            slaprf_scale_min_k4(is + 1, scales, &sc2, &m2);

            const uint8_t *q_sub = qs + (is / 2) * 32;
            const int8_t  *x1 = xb->qs + is * 32;
            const int8_t  *x2 = x1 + 32;

            int32_t s1 = 0;
            int32_t s2 = 0;

#if defined(__aarch64__) && defined(__clang__)
            const uint8x16_t mask4 = vdupq_n_u8(0x0F);
            int32x4_t acc1 = vdupq_n_s32(0);
            int32x4_t acc2 = vdupq_n_s32(0);
            for (int l = 0; l < 32; l += 16) {
                uint8x16_t qv = vld1q_u8(q_sub + l);
                int8x16_t q_lo = vreinterpretq_s8_u8(vandq_u8(qv, mask4));
                int8x16_t q_hi = vreinterpretq_s8_u8(vshrq_n_u8(qv, 4));
                int8x16_t xv1 = vld1q_s8(x1 + l);
                int8x16_t xv2 = vld1q_s8(x2 + l);
                acc1 = vdotq_s32(acc1, q_lo, xv1);
                acc2 = vdotq_s32(acc2, q_hi, xv2);
            }
            s1 = vaddvq_s32(acc1);
            s2 = vaddvq_s32(acc2);
#elif defined(__aarch64__) || defined(_M_ARM64)
            const uint8x16_t mask4 = vdupq_n_u8(0x0F);
            int32x4_t acc1 = vdupq_n_s32(0);
            int32x4_t acc2 = vdupq_n_s32(0);
            for (int l = 0; l < 32; l += 16) {
                uint8x16_t qv = vld1q_u8(q_sub + l);
                int8x16_t q_lo = vreinterpretq_s8_u8(vandq_u8(qv, mask4));
                int8x16_t q_hi = vreinterpretq_s8_u8(vshrq_n_u8(qv, 4));
                int8x16_t xv1 = vld1q_s8(x1 + l);
                int8x16_t xv2 = vld1q_s8(x2 + l);

                int16x8_t p1 = vmull_s8(vget_low_s8(q_lo), vget_low_s8(xv1));
                p1 = vmlal_s8(p1, vget_high_s8(q_lo), vget_high_s8(xv1));
                acc1 = vpadalq_s16(acc1, p1);

                int16x8_t p2 = vmull_s8(vget_low_s8(q_hi), vget_low_s8(xv2));
                p2 = vmlal_s8(p2, vget_high_s8(q_hi), vget_high_s8(xv2));
                acc2 = vpadalq_s16(acc2, p2);
            }
            s1 = vaddvq_s32(acc1);
            s2 = vaddvq_s32(acc2);
#else
            for (int l = 0; l < 32; ++l) {
                uint8_t qb = q_sub[l];
                s1 += (int32_t)(qb & 0x0F) * (int32_t)x1[l];
                s2 += (int32_t)(qb >> 4)   * (int32_t)x2[l];
            }
#endif
            sum_q += (int32_t)sc1 * s1 + (int32_t)sc2 * s2;
            int32_t bs1 = (int32_t)xb->bsums[is * 2] + (int32_t)xb->bsums[is * 2 + 1];
            int32_t bs2 = (int32_t)xb->bsums[(is + 1) * 2] + (int32_t)xb->bsums[(is + 1) * 2 + 1];
            sum_m += (int32_t)m1 * bs1 + (int32_t)m2 * bs2;
        }
        total += xb->d * (d * (float)sum_q - dmin * (float)sum_m);
    }
    return total;
}

static SLAPRF_TARGET_DOTPROD float slaprf_dot_q6k_q8k(const uint8_t *w_row, int nb, const slaprf_q8k_t *x_blocks, const float *fp16_tbl) {
    float total = 0.0f;
    for (int b = 0; b < nb; ++b) {
        const uint8_t *blk = w_row + b * 210;
        const uint8_t *ql = blk;
        const uint8_t *qh = blk + 128;
        const int8_t  *sc = (const int8_t *)(blk + 192);
        uint16_t hd;
        memcpy(&hd, blk + 208, 2);
        const float d = slaprf_fp16_to_fp32(hd, fp16_tbl);
        const slaprf_q8k_t *xb = &x_blocks[b];

        int32_t block_sum = 0;
        for (int half = 0; half < 2; ++half) {
            const uint8_t *ql_sub = ql + half * 64;
            const uint8_t *qh_sub = qh + half * 32;
            const int8_t  *sc_sub = sc + half * 8;
            const int8_t  *x_sub  = xb->qs + half * 128;
            const int16_t *bs_sub = xb->bsums + half * 8;

            for (int h16 = 0; h16 < 2; ++h16) {
                int l_start = h16 * 16;
                int32_t s1 = 0, s2 = 0, s3 = 0, s4 = 0;
#if defined(__aarch64__) && defined(__clang__)
                const uint8x16_t m0f = vdupq_n_u8(0x0F);
                const uint8x16_t m03 = vdupq_n_u8(0x03);
                uint8x16_t ql0 = vld1q_u8(ql_sub + l_start);
                uint8x16_t ql1 = vld1q_u8(ql_sub + l_start + 32);
                uint8x16_t qhv = vld1q_u8(qh_sub + l_start);

                int8x16_t u1 = vreinterpretq_s8_u8(vorrq_u8(vandq_u8(ql0, m0f), vshlq_n_u8(vandq_u8(qhv, m03), 4)));
                int8x16_t u2 = vreinterpretq_s8_u8(vorrq_u8(vandq_u8(ql1, m0f), vshlq_n_u8(vandq_u8(vshrq_n_u8(qhv, 2), m03), 4)));
                int8x16_t u3 = vreinterpretq_s8_u8(vorrq_u8(vshrq_n_u8(ql0, 4), vshlq_n_u8(vandq_u8(vshrq_n_u8(qhv, 4), m03), 4)));
                int8x16_t u4 = vreinterpretq_s8_u8(vorrq_u8(vshrq_n_u8(ql1, 4), vshlq_n_u8(vshrq_n_u8(qhv, 6), 4)));

                int8x16_t x1 = vld1q_s8(x_sub + l_start);
                int8x16_t x2 = vld1q_s8(x_sub + 32 + l_start);
                int8x16_t x3 = vld1q_s8(x_sub + 64 + l_start);
                int8x16_t x4 = vld1q_s8(x_sub + 96 + l_start);

                int32x4_t v1 = vdotq_s32(vdupq_n_s32(0), u1, x1);
                int32x4_t v2 = vdotq_s32(vdupq_n_s32(0), u2, x2);
                int32x4_t v3 = vdotq_s32(vdupq_n_s32(0), u3, x3);
                int32x4_t v4 = vdotq_s32(vdupq_n_s32(0), u4, x4);

                int32x4_t wsum = vmulq_n_s32(v1, (int32_t)sc_sub[h16 + 0]);
                wsum = vmlaq_n_s32(wsum, v2, (int32_t)sc_sub[h16 + 2]);
                wsum = vmlaq_n_s32(wsum, v3, (int32_t)sc_sub[h16 + 4]);
                wsum = vmlaq_n_s32(wsum, v4, (int32_t)sc_sub[h16 + 6]);

                int32_t bias = 32 * (
                    (int32_t)sc_sub[h16 + 0] * (int32_t)bs_sub[h16] +
                    (int32_t)sc_sub[h16 + 2] * (int32_t)bs_sub[2 + h16] +
                    (int32_t)sc_sub[h16 + 4] * (int32_t)bs_sub[4 + h16] +
                    (int32_t)sc_sub[h16 + 6] * (int32_t)bs_sub[6 + h16]
                );
                block_sum += vaddvq_s32(wsum) - bias;
                continue;
#elif defined(__aarch64__) || defined(_M_ARM64)
                const uint8x16_t m0f = vdupq_n_u8(0x0F);
                const uint8x16_t m03 = vdupq_n_u8(0x03);
                uint8x16_t ql0 = vld1q_u8(ql_sub + l_start);
                uint8x16_t ql1 = vld1q_u8(ql_sub + l_start + 32);
                uint8x16_t qhv = vld1q_u8(qh_sub + l_start);

                int8x16_t u1 = vreinterpretq_s8_u8(vorrq_u8(vandq_u8(ql0, m0f), vshlq_n_u8(vandq_u8(qhv, m03), 4)));
                int8x16_t u2 = vreinterpretq_s8_u8(vorrq_u8(vandq_u8(ql1, m0f), vshlq_n_u8(vandq_u8(vshrq_n_u8(qhv, 2), m03), 4)));
                int8x16_t u3 = vreinterpretq_s8_u8(vorrq_u8(vshrq_n_u8(ql0, 4), vshlq_n_u8(vandq_u8(vshrq_n_u8(qhv, 4), m03), 4)));
                int8x16_t u4 = vreinterpretq_s8_u8(vorrq_u8(vshrq_n_u8(ql1, 4), vshlq_n_u8(vshrq_n_u8(qhv, 6), 4)));

                int8x16_t x1 = vld1q_s8(x_sub + l_start);
                int8x16_t x2 = vld1q_s8(x_sub + 32 + l_start);
                int8x16_t x3 = vld1q_s8(x_sub + 64 + l_start);
                int8x16_t x4 = vld1q_s8(x_sub + 96 + l_start);

                int16x8_t p1 = vmlal_s8(vmull_s8(vget_low_s8(u1), vget_low_s8(x1)), vget_high_s8(u1), vget_high_s8(x1));
                int16x8_t p2 = vmlal_s8(vmull_s8(vget_low_s8(u2), vget_low_s8(x2)), vget_high_s8(u2), vget_high_s8(x2));
                int16x8_t p3 = vmlal_s8(vmull_s8(vget_low_s8(u3), vget_low_s8(x3)), vget_high_s8(u3), vget_high_s8(x3));
                int16x8_t p4 = vmlal_s8(vmull_s8(vget_low_s8(u4), vget_low_s8(x4)), vget_high_s8(u4), vget_high_s8(x4));

                s1 = vaddlvq_s16(p1);
                s2 = vaddlvq_s16(p2);
                s3 = vaddlvq_s16(p3);
                s4 = vaddlvq_s16(p4);
#else
                for (int l = l_start; l < l_start + 16; ++l) {
                    uint8_t ql0 = ql_sub[l];
                    uint8_t ql1 = ql_sub[l + 32];
                    uint8_t qhb = qh_sub[l];
                    int32_t u1 = (int32_t)((ql0 & 0x0F) | (((qhb >> 0) & 3) << 4));
                    int32_t u2 = (int32_t)((ql1 & 0x0F) | (((qhb >> 2) & 3) << 4));
                    int32_t u3 = (int32_t)((ql0 >> 4)   | (((qhb >> 4) & 3) << 4));
                    int32_t u4 = (int32_t)((ql1 >> 4)   | (((qhb >> 6) & 3) << 4));
                    s1 += u1 * (int32_t)x_sub[l];
                    s2 += u2 * (int32_t)x_sub[32 + l];
                    s3 += u3 * (int32_t)x_sub[64 + l];
                    s4 += u4 * (int32_t)x_sub[96 + l];
                }
#endif
                s1 -= 32 * (int32_t)bs_sub[h16];
                s2 -= 32 * (int32_t)bs_sub[2 + h16];
                s3 -= 32 * (int32_t)bs_sub[4 + h16];
                s4 -= 32 * (int32_t)bs_sub[6 + h16];

                block_sum += (int32_t)sc_sub[h16 + 0] * s1 +
                             (int32_t)sc_sub[h16 + 2] * s2 +
                             (int32_t)sc_sub[h16 + 4] * s3 +
                             (int32_t)sc_sub[h16 + 6] * s4;
            }
        }
        total += d * xb->d * (float)block_sum;
    }
    return total;
}

static SLAPRF_TARGET_DOTPROD void slaprf_matbatch_q4k(
    float *dst,
    const uint8_t *w_data,
    int nb,
    int n_rows,
    int start_row,
    int end_row,
    int n_tokens,
    const slaprf_q8k_t *x_batch,
    const float *fp16_tbl
) {
#if defined(__aarch64__) && defined(__clang__)
    const uint8x16_t mask4 = vdupq_n_u8(0x0F);
    int r = start_row;
    for (; r + 3 < end_row; r += 4) {
        const uint8_t *w0 = w_data + (size_t)(r + 0) * (size_t)(nb * 144);
        const uint8_t *w1 = w_data + (size_t)(r + 1) * (size_t)(nb * 144);
        const uint8_t *w2 = w_data + (size_t)(r + 2) * (size_t)(nb * 144);
        const uint8_t *w3 = w_data + (size_t)(r + 3) * (size_t)(nb * 144);
        for (int t = 0; t < n_tokens; ++t) {
            const slaprf_q8k_t *xt = x_batch + (size_t)t * (size_t)nb;
            float tot0 = 0.0f, tot1 = 0.0f, tot2 = 0.0f, tot3 = 0.0f;
            for (int b = 0; b < nb; ++b) {
                const slaprf_q8k_t *xb = &xt[b];
                const uint8_t *b0 = w0 + b * 144;
                const uint8_t *b1 = w1 + b * 144;
                const uint8_t *b2 = w2 + b * 144;
                const uint8_t *b3 = w3 + b * 144;

                __fp16 hd0, hm0, hd1, hm1, hd2, hm2, hd3, hm3;
                memcpy(&hd0, b0, 2); memcpy(&hm0, b0 + 2, 2);
                memcpy(&hd1, b1, 2); memcpy(&hm1, b1 + 2, 2);
                memcpy(&hd2, b2, 2); memcpy(&hm2, b2 + 2, 2);
                memcpy(&hd3, b3, 2); memcpy(&hm3, b3 + 2, 2);

                int32x4_t vsum0 = vdupq_n_s32(0);
                int32x4_t vsum1 = vdupq_n_s32(0);
                int32x4_t vsum2 = vdupq_n_s32(0);
                int32x4_t vsum3 = vdupq_n_s32(0);
                int32_t sm0 = 0, sm1 = 0, sm2 = 0, sm3 = 0;

                for (int is = 0; is < 8; is += 2) {
                    const int8_t *x1 = xb->qs + is * 32;
                    int8x16_t xv1_0 = vld1q_s8(x1);
                    int8x16_t xv1_1 = vld1q_s8(x1 + 16);
                    int8x16_t xv2_0 = vld1q_s8(x1 + 32);
                    int8x16_t xv2_1 = vld1q_s8(x1 + 48);

                    int32_t bs1 = (int32_t)xb->bsums[is * 2] + (int32_t)xb->bsums[is * 2 + 1];
                    int32_t bs2 = (int32_t)xb->bsums[(is + 1) * 2] + (int32_t)xb->bsums[(is + 1) * 2 + 1];
                    const int q_off = 16 + (is / 2) * 32;

                    #define SLAPRF_Q4K_ROW_STEP(B_PTR, VSUM, SM) do { \
                        uint8_t sc1, m1, sc2, m2; \
                        slaprf_scale_min_k4(is, (B_PTR) + 4, &sc1, &m1); \
                        slaprf_scale_min_k4(is + 1, (B_PTR) + 4, &sc2, &m2); \
                        uint8x16_t qv0 = vld1q_u8((B_PTR) + q_off); \
                        uint8x16_t qv1 = vld1q_u8((B_PTR) + q_off + 16); \
                        int32x4_t a1 = vdotq_s32(vdupq_n_s32(0), vreinterpretq_s8_u8(vandq_u8(qv0, mask4)), xv1_0); \
                        a1 = vdotq_s32(a1, vreinterpretq_s8_u8(vandq_u8(qv1, mask4)), xv1_1); \
                        int32x4_t a2 = vdotq_s32(vdupq_n_s32(0), vreinterpretq_s8_u8(vshrq_n_u8(qv0, 4)), xv2_0); \
                        a2 = vdotq_s32(a2, vreinterpretq_s8_u8(vshrq_n_u8(qv1, 4)), xv2_1); \
                        (VSUM) = vmlaq_n_s32((VSUM), a1, (int32_t)sc1); \
                        (VSUM) = vmlaq_n_s32((VSUM), a2, (int32_t)sc2); \
                        (SM) += (int32_t)m1 * bs1 + (int32_t)m2 * bs2; \
                    } while (0)

                    SLAPRF_Q4K_ROW_STEP(b0, vsum0, sm0);
                    SLAPRF_Q4K_ROW_STEP(b1, vsum1, sm1);
                    SLAPRF_Q4K_ROW_STEP(b2, vsum2, sm2);
                    SLAPRF_Q4K_ROW_STEP(b3, vsum3, sm3);
                    #undef SLAPRF_Q4K_ROW_STEP
                }
                tot0 += xb->d * ((float)hd0 * (float)vaddvq_s32(vsum0) - (float)hm0 * (float)sm0);
                tot1 += xb->d * ((float)hd1 * (float)vaddvq_s32(vsum1) - (float)hm1 * (float)sm1);
                tot2 += xb->d * ((float)hd2 * (float)vaddvq_s32(vsum2) - (float)hm2 * (float)sm2);
                tot3 += xb->d * ((float)hd3 * (float)vaddvq_s32(vsum3) - (float)hm3 * (float)sm3);
            }
            float *dst_t = dst + (size_t)t * (size_t)n_rows + (size_t)r;
            dst_t[0] = tot0;
            dst_t[1] = tot1;
            dst_t[2] = tot2;
            dst_t[3] = tot3;
        }
    }
    for (; r < end_row; ++r) {
        const uint8_t *w_row = w_data + (size_t)r * (size_t)(nb * 144);
        for (int t = 0; t < n_tokens; ++t) {
            dst[(size_t)t * (size_t)n_rows + (size_t)r] = slaprf_dot_q4k_q8k(w_row, nb, x_batch + (size_t)t * (size_t)nb, fp16_tbl);
        }
    }
#else
    const int tile_r = (nb <= 8) ? 32 : 16;
    for (int r0 = start_row; r0 < end_row; r0 += tile_r) {
        int r1 = r0 + tile_r;
        if (r1 > end_row) r1 = end_row;
        for (int t = 0; t < n_tokens; ++t) {
            const slaprf_q8k_t *xt = x_batch + (size_t)t * (size_t)nb;
            float *dst_t = dst + (size_t)t * (size_t)n_rows;
            for (int r = r0; r < r1; ++r) {
                const uint8_t *w_row = w_data + (size_t)r * (size_t)(nb * 144);
                dst_t[r] = slaprf_dot_q4k_q8k(w_row, nb, xt, fp16_tbl);
            }
        }
    }
#endif
}

static SLAPRF_TARGET_DOTPROD void slaprf_matbatch_q6k(
    float *dst,
    const uint8_t *w_data,
    int nb,
    int n_rows,
    int start_row,
    int end_row,
    int n_tokens,
    const slaprf_q8k_t *x_batch,
    const float *fp16_tbl
) {
    const int tile_r = (nb <= 8) ? 24 : 12;
    for (int r0 = start_row; r0 < end_row; r0 += tile_r) {
        int r1 = r0 + tile_r;
        if (r1 > end_row) r1 = end_row;
        for (int t = 0; t < n_tokens; ++t) {
            const slaprf_q8k_t *xt = x_batch + (size_t)t * (size_t)nb;
            float *dst_t = dst + (size_t)t * (size_t)n_rows;
            for (int r = r0; r < r1; ++r) {
                const uint8_t *w_row = w_data + (size_t)r * (size_t)(nb * 210);
                dst_t[r] = slaprf_dot_q6k_q8k(w_row, nb, xt, fp16_tbl);
            }
        }
    }
}
*/
import "C"

import "unsafe"

// Compile-time struct layout guard ensuring Go `Q8KBlock` matches C `slaprf_q8k_t` byte-for-byte.
var _ [unsafe.Sizeof(Q8KBlock{}) - unsafe.Sizeof(C.slaprf_q8k_t{})]byte
var _ [unsafe.Sizeof(C.slaprf_q8k_t{}) - unsafe.Sizeof(Q8KBlock{})]byte

func dotSingleRow(rawRow []byte, ttype GGMLType, nCols int, xFloat []float32, xQ8 []Q8KBlock) float32 {
	if len(rawRow) == 0 {
		return 0
	}
	switch ttype {
	case TypeQ4_K:
		return float32(C.slaprf_dot_q4k_q8k(
			(*C.uint8_t)(unsafe.Pointer(&rawRow[0])),
			C.int(nCols/qkK),
			(*C.slaprf_q8k_t)(unsafe.Pointer(&xQ8[0])),
			(*C.float)(unsafe.Pointer(&fp16Table[0])),
		))
	case TypeQ6_K:
		return float32(C.slaprf_dot_q6k_q8k(
			(*C.uint8_t)(unsafe.Pointer(&rawRow[0])),
			C.int(nCols/qkK),
			(*C.slaprf_q8k_t)(unsafe.Pointer(&xQ8[0])),
			(*C.float)(unsafe.Pointer(&fp16Table[0])),
		))
	default:
		return dotRowGo(rawRow, ttype, nCols, xFloat, xQ8)
	}
}

func matVecRange(dst []float32, wData []byte, ttype GGMLType, nCols, rowBytes, startRow, endRow int, xFloat []float32, xQ8 []Q8KBlock) {
	if startRow >= endRow {
		return
	}
	switch ttype {
	case TypeQ4_K:
		C.slaprf_matbatch_q4k(
			(*C.float)(unsafe.Pointer(&dst[0])),
			(*C.uint8_t)(unsafe.Pointer(&wData[0])),
			C.int(nCols/qkK),
			C.int(len(dst)),
			C.int(startRow),
			C.int(endRow),
			C.int(1),
			(*C.slaprf_q8k_t)(unsafe.Pointer(&xQ8[0])),
			(*C.float)(unsafe.Pointer(&fp16Table[0])),
		)
	case TypeQ6_K:
		C.slaprf_matbatch_q6k(
			(*C.float)(unsafe.Pointer(&dst[0])),
			(*C.uint8_t)(unsafe.Pointer(&wData[0])),
			C.int(nCols/qkK),
			C.int(len(dst)),
			C.int(startRow),
			C.int(endRow),
			C.int(1),
			(*C.slaprf_q8k_t)(unsafe.Pointer(&xQ8[0])),
			(*C.float)(unsafe.Pointer(&fp16Table[0])),
		)
	default:
		for r := startRow; r < endRow; r++ {
			raw := wData[r*rowBytes : (r+1)*rowBytes]
			dst[r] = dotRowGo(raw, ttype, nCols, xFloat, xQ8)
		}
	}
}

func matBatchRange(dst []float32, wData []byte, ttype GGMLType, nCols, nRows, rowBytes, startRow, endRow, nTokens int, xFloats []float32, xQ8Batch []Q8KBlock) {
	if startRow >= endRow || nTokens <= 0 {
		return
	}
	switch ttype {
	case TypeQ4_K:
		C.slaprf_matbatch_q4k(
			(*C.float)(unsafe.Pointer(&dst[0])),
			(*C.uint8_t)(unsafe.Pointer(&wData[0])),
			C.int(nCols/qkK),
			C.int(nRows),
			C.int(startRow),
			C.int(endRow),
			C.int(nTokens),
			(*C.slaprf_q8k_t)(unsafe.Pointer(&xQ8Batch[0])),
			(*C.float)(unsafe.Pointer(&fp16Table[0])),
		)
	case TypeQ6_K:
		C.slaprf_matbatch_q6k(
			(*C.float)(unsafe.Pointer(&dst[0])),
			(*C.uint8_t)(unsafe.Pointer(&wData[0])),
			C.int(nCols/qkK),
			C.int(nRows),
			C.int(startRow),
			C.int(endRow),
			C.int(nTokens),
			(*C.slaprf_q8k_t)(unsafe.Pointer(&xQ8Batch[0])),
			(*C.float)(unsafe.Pointer(&fp16Table[0])),
		)
	default:
		nb := nCols / qkK
		for r := startRow; r < endRow; r++ {
			raw := wData[r*rowBytes : (r+1)*rowBytes]
			for t := 0; t < nTokens; t++ {
				var xF []float32
				if len(xFloats) >= (t+1)*nCols {
					xF = xFloats[t*nCols : (t+1)*nCols]
				}
				var xQ []Q8KBlock
				if nb > 0 && len(xQ8Batch) >= (t+1)*nb {
					xQ = xQ8Batch[t*nb : (t+1)*nb]
				}
				dst[t*nRows+r] = dotRowGo(raw, ttype, nCols, xF, xQ)
			}
		}
	}
}

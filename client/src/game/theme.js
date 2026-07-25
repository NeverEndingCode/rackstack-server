export const cardBg = '#161F2B';
export const cardBorder = '#26313F';
export const inset = '#1D2836';
export const textMain = '#EAEFF5';
export const textDim = '#7C8AA0';
export const amber = '#E8A33D';
export const teal = '#4FC3B0';
export const violet = '#9C8CF2';
export const danger = '#E05C4C';

export function buyBtnStyle(afford) {
  return {
    background: afford ? inset : cardBg,
    border: `1px solid ${cardBorder}`,
    color: afford ? textMain : textDim,
    opacity: afford ? 1 : 0.55,
    cursor: afford ? 'pointer' : 'not-allowed',
  };
}

import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('app/page.tsx', 'utf8');

const before = c.length;

// Fix totalCriteria - 총 결정 기준
c = c.replace('>총 결정 기준<', '>{T.totalCriteria}<');

// Fix productsConsidered - 고려한 제품 수
c = c.replace('>고려한 제품 수<', '>{T.productsConsidered}<');

// Fix exploredCategories - 탐색 카테고리
c = c.replace('>탐색 카테고리<', '>{T.exploredCategories}<');

writeFileSync('app/page.tsx', c, 'utf8');

console.log('Before:', before, 'After:', c.length, 'Diff:', c.length - before);
console.log('Done');

import * as cheerio from 'cheerio';

const url = 'https://search.danawa.com/dsearch.php?query=%EB%94%94%EB%9F%AD%EC%8A%A4+%EC%9C%A0%EB%AA%A8%EC%B0%A8&tab=goods';
const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://www.danawa.com/'
  }
});
const html = await res.text();
const $ = cheerio.load(html);

let count = 0;
$('ul.product_list > li.prod_item').each((i, el) => {
  if (count >= 5) return false;
  const name = $(el).find('.prod_name a').first().text().trim();
  const price = $(el).find('.price_sect strong').first().text().trim();
  const imgEl = $(el).find('.thumb_link img, .thumb_image img').first();
  const imgSrc = imgEl.attr('data-src') || imgEl.attr('data-original') || imgEl.attr('data-lazy') || imgEl.attr('src') || '';
  const link = $(el).find('.prod_name a').first().attr('href') || '';
  if (name) {
    console.log('---');
    console.log('Name:', name.slice(0, 60));
    console.log('Price:', price);
    console.log('Img:', imgSrc.slice(0, 100));
    console.log('Link:', link.slice(0, 80));
    count++;
  }
});
console.log('\nTotal parsed:', count);

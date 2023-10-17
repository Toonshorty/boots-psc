import fetch from 'node-fetch';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const POSTCODE_LOOKUP_URL = 'https://www.boots.com/online/psc/geocoder/postalcode';
const STORE_LOOKUP_URL = 'https://www.boots.com/online/psc/search/store';
const STOCK_LOOKUP_URL = 'https://www.boots.com/online/psc/itemStock';
const RADIUS = 50;

const prompt = await inquirer.prompt(
  [
    {
      name: 'postcode',
      message: 'Enter a valid UK postcode:',
      type: 'input'
    },
    {
      name: 'medicationId',
      message: 'Please select a dosage:',
      type: 'list',
      choices: [
        { name: 'Lisdexamfetamine 20mg capsules', value: '42013311000001109' },
        { name: 'Lisdexamfetamine 30mg capsules', value: '42013411000001102' },
        { name: 'Lisdexamfetamine 40mg capsules', value: '42013511000001103' },
        { name: 'Lisdexamfetamine 50mg capsules', value: '42013611000001104' },
        { name: 'Lisdexamfetamine 60mg capsules', value: '42013711000001108' },
        { name: 'Lisdexamfetamine 70mg capsules', value: '42013811000001100' }
      ]
    }
  ]
);

const getGeoDataForPostcode = async (postcode) => {
  const url = new URL(POSTCODE_LOOKUP_URL);
  const searchParams = new URLSearchParams(url.search);

  searchParams.set('postalcode', postcode);
  url.search = searchParams.toString();

  const request = await fetch(url);
  const json = await request.json();

  if (!request.ok || !json.results) {
    console.error('Unable to fetch postcode data.', json, request);
    return;
  }

  return json.results[0].geometry.location;
};

const getStoresInRadius = async (geodata, radius) => {
  const url = new URL(STORE_LOOKUP_URL);
  const searchParams = new URLSearchParams(url.search);

  const fetchStores = async (offset) => {
    searchParams.set('type', 'geo');
    searchParams.set('radius', radius);
    searchParams.set('from', offset);
    searchParams.set('latitude', geodata.lat);
    searchParams.set('longitude', geodata.lng);
    url.search = searchParams.toString();

    const request = await fetch(url);
    const json = await request.json();

    if (!request.ok || !json.results) {
      console.error('Unable to fetch stores.', json, request);
      return;
    }

    return json;
  };

  const storeResults = [];
  let offset = 0;
  let hasNextPage = true;

  do {
    const { size, total, results } = await fetchStores(offset);

    const start = offset + 1;
    const end = Math.min(offset + size, total);

    if (end === total) hasNextPage = false;

    console.info(chalk.gray(`Fetched stores ${start} to ${end} of ${total}`));

    const storeData = results.map((store) => ({
      storeId: store.Location.id,
      displayName: store.Location.displayname,
      postcode: store.Location?.Address?.postcode,
      phoneNumber: store.Location?.contactDetails?.phone
    }));

    storeResults.push(...storeData);

    offset += size;

    await new Promise((r) => setTimeout(r, 6000));
  } while (hasNextPage);

  console.log(chalk.green(`Fetched ${storeResults.length} stores.`));

  return storeResults;
};

const getStock = async (medicationId, storeIds) => {
  const url = new URL(STOCK_LOOKUP_URL);

  const requestBody = JSON.stringify({
    productIdList: [medicationId],
    storeIdList: storeIds
  });

  const request = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: requestBody
  });
  const json = await request.json();

  if (!request.ok || !json.stockLevels) {
    console.error('Unable to fetch stock data.', json, request);
    throw new Error('Unable to fetch stock data.');
  }

  return json.stockLevels;
};

const { postcode, medicationId } = prompt;
const trimmedPostcode = postcode.replace(/\s+/g, '');

const dataDirectoryExists = existsSync('./data');
if (!dataDirectoryExists)
  await mkdir('./data');

const storeJsonFilename = `./data/stores_${trimmedPostcode}_${RADIUS}.json`;

let storeData;

try {
  console.log(chalk.gray('Checking if a JSON file already exists with store data for this postcode...'));
  const storeJson = await readFile(storeJsonFilename);
  storeData = JSON.parse(storeJson);
} catch {
  // No JSON file found for postcode, fetch stores
  console.log(chalk.yellow(`No JSON store data exists for this postcode, fetching stores within a ${RADIUS} mile radius (this may take a few minutes)...`));
  const geodata = await getGeoDataForPostcode(postcode);
  const stores = await getStoresInRadius(geodata, RADIUS);
  // Export/cache store data to avoid making requests each time
  console.log(chalk.grey('Writing store data to a JSON file...'));
  await writeFile(storeJsonFilename, JSON.stringify(stores));
  storeData = stores;
}

const pageSize = 10;
const pages = Math.floor(storeData.length / pageSize);

const stockData = [];

let currentPage = 1;

console.log(chalk.grey(`Fetching stock for ${pages * pageSize} stores...`));

do {
  const offset = (currentPage - 1) * pageSize;
  const stores = storeData.map(s => s.storeId).slice(offset, offset + pageSize);

  console.debug(`Fetching page ${currentPage} of ${pages} (stores ${offset + 1} - ${offset + pageSize})...`);

  try {
    const stock = await getStock(medicationId, stores);
    const storeStock = stock.map(stock => {
      const store = storeData.find(store => store.storeId === parseInt(stock.storeId, 10));
      return {
        storeName: store.displayName,
        storePostcode: store.postcode,
        storePhoneNumber: store.phoneNumber,
        stockStatus: stock.stockLevel
      }
    });

    stockData.push(...storeStock);
  } catch {
    console.error('There there was a problem fetching stock for this page.');
  } finally {
    // Don't delay after the last request
    if (currentPage != pages)
      await new Promise((r) => setTimeout(r, 6000));

    currentPage++;
  }
} while (currentPage <= pages);

const inStock = stockData.filter(d => d.stockStatus === 'G');

console.log(inStock.length
  ? chalk.green(`Found stock in ${inStock.length} locations.`)
  : chalk.red(`Found stock in ${inStock.length} locations.`),
  inStock);

console.log(chalk.gray('Writing stock data to JSON file...'));

const stockJsonFilename = `./data/stock_${trimmedPostcode}_${RADIUS}_${new Date().getTime()}.json`;
writeFile(stockJsonFilename, JSON.stringify(stockData));

console.log(chalk.green('Stock check complete.'));
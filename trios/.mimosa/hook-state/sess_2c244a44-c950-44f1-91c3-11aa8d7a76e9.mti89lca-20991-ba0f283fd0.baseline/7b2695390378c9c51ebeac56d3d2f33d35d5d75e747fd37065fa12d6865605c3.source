/**
 * Builds the consolidated eval set (~50 hard, multi-step browser tasks).
 * All tasks are hand-written for realism and complexity.
 *
 * Usage: bun apps/eval/scripts/build-consolidated-set.ts
 */

interface EvalTask {
  query_id: string
  dataset: string
  query: string
  graders: string[]
  start_url: string
  metadata: {
    original_task_id: string
    website: string
    category: string
    additional: Record<string, unknown>
  }
}

function task(
  id: string,
  website: string,
  category: string,
  startUrl: string,
  query: string,
  additional: Record<string, unknown> = {},
): EvalTask {
  return {
    query_id: id,
    dataset: 'browseros-eval',
    query,
    graders: ['webvoyager_grader', 'fara_combined'],
    start_url: startUrl,
    metadata: {
      original_task_id: id,
      website,
      category,
      additional,
    },
  }
}

const tasks: EvalTask[] = [
  // ── Shopping & E-Commerce ──────────────────────────────────────────
  task(
    'amazon-multi-filter-1',
    'Amazon',
    'shopping',
    'https://www.amazon.com/',
    'Find a noise-cancelling over-ear Bluetooth headphone on Amazon with at least 4.5 stars and over 1000 reviews, priced between $50 and $100, and add the cheapest option to my cart.',
  ),
  task(
    'bestbuy-trade-in-1',
    'Best Buy',
    'shopping',
    'https://www.bestbuy.com/',
    'Check the trade-in value of a 7th generation Intel Core i5 HP laptop with 8 GB RAM running Windows 10 in fair condition on Best Buy.',
  ),
  task(
    'target-grocery-1',
    'Target',
    'shopping',
    'https://www.target.com/',
    'Find a frozen vegan cheese pizza on Target priced between $5 and $10 that is available for same-day delivery to zip code 90210.',
  ),
  task(
    'walmart-compare-1',
    'Walmart',
    'shopping',
    'https://www.walmart.com/',
    'Compare the top two best-selling 65-inch 4K smart TVs on Walmart by price, rating, and number of reviews, and tell me which one offers better value.',
  ),
  task(
    'nike-shoe-1',
    'Nike',
    'shopping',
    'https://www.nike.com/',
    "Find a men's running shoe on Nike in size 10, color black, with a price under $130 and at least 4 stars. Add it to the cart.",
  ),
  task(
    'costco-membership-1',
    'Costco',
    'shopping',
    'https://www.costco.com/',
    'Find the price difference between Gold Star and Executive membership on Costco and list the extra benefits the Executive membership provides.',
  ),
  task(
    'ikea-furniture-1',
    'IKEA',
    'shopping',
    'https://www.ikea.com/',
    'Find the cheapest black leather sofa on IKEA with at least 3 seats and a customer rating of 4 stars or higher. Show me the price and dimensions.',
  ),
  task(
    'apple-config-1',
    'Apple',
    'shopping',
    'https://www.apple.com/',
    'Configure a 16-inch MacBook Pro with M4 Max chip, 48 GB RAM, and 1 TB SSD on the Apple Store. What is the total price?',
  ),
  task(
    'homedepot-tool-1',
    'Home Depot',
    'shopping',
    'https://www.homedepot.com/',
    'Find a cordless drill kit on Home Depot with at least 2 batteries included, 20V or higher, rated 4.5 stars or above, and priced under $150.',
  ),

  // ── Travel & Booking ───────────────────────────────────────────────
  task(
    'booking-hotel-1',
    'Booking.com',
    'travel',
    'https://www.booking.com/',
    'Find the highest-rated hotel in downtown Chicago for 2 adults checking in next Friday and checking out Sunday, with free cancellation and breakfast included. Show me the price breakdown.',
  ),
  task(
    'airbnb-stay-1',
    'Airbnb',
    'travel',
    'https://www.airbnb.com/',
    'Find an entire home in Austin, TX for 4 guests with a pool and free parking, checking in two weeks from today for 3 nights. Sort by lowest price and show me the top result.',
  ),
  task(
    'google-maps-transit-1',
    'Google Maps',
    'travel',
    'https://www.google.com/maps/',
    'Find the fastest public transit route from Times Square, New York to JFK Airport departing at 8 AM tomorrow. How long does the trip take and what transfers are needed?',
  ),
  task(
    'expedia-package-1',
    'Expedia',
    'travel',
    'https://www.expedia.com/',
    'Search for a round-trip flight plus hotel package from San Francisco to Miami for 2 travelers, departing next month on the 15th and returning on the 20th. Show me the cheapest bundle.',
  ),
  task(
    'spothero-parking-1',
    'SpotHero',
    'travel',
    'https://spothero.com/',
    'Find covered parking near the Museum of Modern Art in San Francisco from this Saturday 10 AM to 4 PM for a full-size SUV. Show me the cheapest option with the walk time.',
  ),

  // ── Food & Recipes ─────────────────────────────────────────────────
  task(
    'allrecipes-diet-1',
    'Allrecipes',
    'food',
    'https://www.allrecipes.com/',
    'Find a gluten-free chicken dinner recipe on Allrecipes with at least 4.5 stars, over 50 reviews, and a total cook time under 45 minutes. List the ingredients.',
  ),
  task(
    'yelp-restaurant-1',
    'Yelp',
    'food',
    'https://www.yelp.com/',
    'Find the highest-rated Mexican restaurant in downtown Los Angeles on Yelp that is open now, accepts reservations, and has a price range of $$ or less. Show me the top 3 most recent reviews.',
  ),

  // ── Real Estate ────────────────────────────────────────────────────
  task(
    'zillow-search-1',
    'Zillow',
    'real-estate',
    'https://www.zillow.com/',
    'Search for 2-bedroom apartments for rent in Seattle, WA under $2500/month with in-unit laundry and parking included. Sort by newest and show me the first three results with their prices.',
  ),
  task(
    'redfin-listing-1',
    'Redfin',
    'real-estate',
    'https://www.redfin.com/',
    'Find the most recently listed 3-bedroom house for sale in Austin, TX between $400,000 and $600,000 with at least 2 bathrooms and a garage. Show the listing details.',
  ),

  // ── Jobs & Career ──────────────────────────────────────────────────
  task(
    'linkedin-jobs-1',
    'LinkedIn',
    'jobs',
    'https://www.linkedin.com/jobs/',
    'Search for remote Senior Software Engineer positions on LinkedIn posted in the last week that offer a salary of $150,000 or more. Show me the first 3 results.',
  ),
  task(
    'glassdoor-salary-1',
    'Glassdoor',
    'jobs',
    'https://www.glassdoor.com/',
    'Look up the average base salary for a Product Manager in San Francisco on Glassdoor and show me the salary range and how it compares to the national average.',
  ),
  task(
    'indeed-jobs-1',
    'Indeed',
    'jobs',
    'https://www.indeed.com/',
    'Find entry-level Data Analyst jobs in New York City on Indeed posted within the last 3 days with a salary estimate of at least $60,000/year. List the top 3 results with company names.',
  ),

  // ── Research & Knowledge ───────────────────────────────────────────
  task(
    'wikipedia-compare-1',
    'Wikipedia',
    'research',
    'https://www.wikipedia.org/',
    'Compare the population, area, and GDP of Germany and France using their Wikipedia pages and summarize which country is larger by each metric.',
  ),
  task(
    'arxiv-search-1',
    'ArXiv',
    'research',
    'https://arxiv.org/',
    'Search for the most recent papers on "large language model alignment" on ArXiv under the cs.CL category, submitted in the last month. Show me the titles and authors of the top 3 results.',
  ),
  task(
    'stackoverflow-debug-1',
    'Stack Overflow',
    'research',
    'https://stackoverflow.com/',
    'Find the highest-voted answer on Stack Overflow for the error "CORS policy: No Access-Control-Allow-Origin header" in a React app making fetch requests. Summarize the solution.',
  ),
  task(
    'ted-talk-1',
    'TED',
    'research',
    'https://www.ted.com/',
    "Find the most viewed TED talk about artificial intelligence that is between 10 and 20 minutes long. What is the speaker's name and the number of views?",
  ),

  // ── Finance & Business ─────────────────────────────────────────────
  task(
    'chase-calculator-1',
    'Chase',
    'finance',
    'https://www.chase.com/',
    'Use the Chase 401(k) calculator to estimate my retirement savings if I start at age 25, retire at 65, contribute $500/month, with a 7% annual return and a current balance of $10,000.',
  ),
  task(
    'sec-filing-1',
    'SEC EDGAR',
    'finance',
    'https://www.sec.gov/cgi-bin/browse-edgar',
    "Find Apple Inc.'s most recent 10-K annual filing on SEC EDGAR and tell me the total revenue reported for the most recent fiscal year.",
  ),

  // ── Health & Wellness ──────────────────────────────────────────────
  task(
    'healthline-diet-1',
    'Healthline',
    'health',
    'https://www.healthline.com/',
    'Find and compare the Mediterranean diet and the DASH diet on Healthline. List the key differences in allowed foods and which one is better for lowering blood pressure.',
  ),
  task(
    'webmd-symptom-1',
    'WebMD',
    'health',
    'https://www.webmd.com/',
    'Use the WebMD symptom checker for an adult male experiencing persistent headache, fatigue, and blurred vision. What possible conditions does it suggest?',
  ),
  task(
    'babycenter-growth-1',
    'BabyCenter',
    'health',
    'https://www.babycenter.com/',
    'Use the child height predictor on BabyCenter for a 5-year-old girl who is currently 3 feet 6 inches tall and weighs 40 pounds. What is the predicted adult height?',
  ),

  // ── Entertainment & Media ──────────────────────────────────────────
  task(
    'youtube-playlist-1',
    'YouTube',
    'entertainment',
    'https://www.youtube.com/',
    'Search for "beginner piano tutorial" on YouTube, filter by videos over 20 minutes long and uploaded this year. Find the one with the most views and tell me the channel name and view count.',
  ),
  task(
    'reddit-thread-1',
    'Reddit',
    'entertainment',
    'https://www.reddit.com/',
    'Find the top post of all time on the r/personalfinance subreddit on Reddit. Summarize the main advice given in the post and the top comment.',
  ),
  task(
    'imdb-movie-1',
    'IMDb',
    'entertainment',
    'https://www.imdb.com/',
    'Look at the IMDb Top 250 movies list and find the highest-rated movie from the 2020s. Show me its title, rating, director, and a brief plot summary.',
  ),
  task(
    'spotify-playlist-1',
    'Spotify',
    'entertainment',
    'https://open.spotify.com/',
    'Find the "Today\'s Top Hits" playlist on Spotify and tell me the first 5 songs listed, including the artist names and the total number of likes the playlist has.',
  ),
  task(
    'espn-stats-1',
    'ESPN',
    'entertainment',
    'https://www.espn.com/',
    "Find the current NBA season's leading scorer on ESPN. Show me their points per game, total points, and their team's current win-loss record.",
  ),
  task(
    'steam-review-1',
    'Steam',
    'entertainment',
    'https://store.steampowered.com/',
    "Find the game that won Steam's Game of the Year 2024 award. Show me its current price, overall review rating, and read the most helpful recent negative review.",
  ),

  // ── Government & Services ──────────────────────────────────────────
  task(
    'govuk-visa-1',
    'GOV.UK',
    'government',
    'https://www.gov.uk/',
    'Check on GOV.UK whether a US citizen needs a visa to work in the UK for 12 months in the technology sector. What type of visa is required and what are the main requirements?',
  ),
  task(
    'irs-refund-1',
    'IRS',
    'government',
    'https://www.irs.gov/',
    'Find the current standard deduction amount for a single filer under 65 on the IRS website for the 2025 tax year. Also find the income tax brackets for single filers.',
  ),

  // ── Automotive ─────────────────────────────────────────────────────
  task(
    'cargurus-search-1',
    'CarGurus',
    'automotive',
    'https://www.cargurus.com/',
    'Find a used 2020-2023 Toyota RAV4 Hybrid on CarGurus near zip code 94102 with under 40,000 miles, priced under $30,000. Sort by lowest price and show me the top result with its deal rating.',
  ),
  task(
    'kbb-value-1',
    'Kelley Blue Book',
    'automotive',
    'https://www.kbb.com/',
    'Look up the trade-in value of a 2019 Honda Civic EX sedan with 45,000 miles in good condition on Kelley Blue Book. What is the fair market range?',
  ),

  // ── Education ──────────────────────────────────────────────────────
  task(
    'kaggle-competition-1',
    'Kaggle',
    'education',
    'https://www.kaggle.com/',
    'Find the currently active Kaggle competition with the highest prize money. Show me the competition name, prize amount, deadline, and the number of teams participating.',
  ),
  task(
    'pypi-package-1',
    'PyPI',
    'education',
    'https://pypi.org/',
    'Search for Python packages on PyPI related to "data validation" that support Python 3.11, have a stable release, and are MIT licensed. Show me the top 3 results by relevance.',
  ),
  task(
    'coursera-course-1',
    'Coursera',
    'education',
    'https://www.coursera.org/',
    'Find a beginner-level machine learning course on Coursera that is free to audit, has a rating of 4.7 or higher, and takes less than 3 months to complete. Show the course name and instructor.',
  ),

  // ── Technology & Tools ─────────────────────────────────────────────
  task(
    'huggingface-model-1',
    'Hugging Face',
    'technology',
    'https://huggingface.co/',
    'Find the most downloaded text-generation model on Hugging Face that was updated in the last month. Show me the model name, download count, and its license.',
  ),
  task(
    'github-repo-1',
    'GitHub',
    'technology',
    'https://github.com/',
    'Find the most starred open-source repository on GitHub that was created in 2025. Show me the repo name, star count, primary language, and a brief description.',
  ),
  task(
    'nvidia-driver-1',
    'NVIDIA',
    'technology',
    'https://www.nvidia.com/',
    'Find the latest NVIDIA driver for an RTX 4090 GPU running on Ubuntu 22.04 with an x86_64 architecture. Show me the driver version number and download size.',
  ),
  task(
    'azure-pricing-1',
    'Azure',
    'technology',
    'https://azure.microsoft.com/',
    'Use the Azure pricing calculator to estimate the monthly cost of running a Standard_D4s_v3 virtual machine in East US region with Linux, 24/7 uptime, and 128 GB premium SSD storage.',
  ),

  // ── Pets & Animals ─────────────────────────────────────────────────
  task(
    'petfinder-adopt-1',
    'Petfinder',
    'pets',
    'https://www.petfinder.com/',
    'Find young female cats available for adoption within 25 miles of zip code 10001 on Petfinder that are good with other cats and are spayed. Show me the first 3 results.',
  ),

  // ── Wine & Beverage ────────────────────────────────────────────────
  task(
    'vivino-wine-1',
    'Vivino',
    'food',
    'https://www.vivino.com/',
    'Find the highest-rated red wine from Napa Valley on Vivino priced under $50 that pairs well with steak. Show me the wine name, rating, and price.',
  ),

  // ── Complex Multi-Hop Tasks ────────────────────────────────────────
  task(
    'multi-hop-weather-flight-1',
    'Google',
    'multi-hop',
    'https://www.google.com/',
    'Search Google for the current weather in Tokyo, Japan, then search for the cheapest round-trip flight from Los Angeles to Tokyo next month on Google Flights. Show me the weather forecast and the flight price.',
  ),
]

const outputPath = 'apps/eval/data/consolidated-eval-set.jsonl'
const content = `${tasks.map((t) => JSON.stringify(t)).join('\n')}\n`

await Bun.write(outputPath, content)

// Summary stats
const byCategory: Record<string, number> = {}
const byWebsite: Record<string, number> = {}
const ids = new Set<string>()
const dupes: string[] = []

for (const t of tasks) {
  if (ids.has(t.query_id)) dupes.push(t.query_id)
  ids.add(t.query_id)
  byCategory[t.metadata.category] = (byCategory[t.metadata.category] || 0) + 1
  byWebsite[t.metadata.website] = (byWebsite[t.metadata.website] || 0) + 1
}

console.log(`\n✓ Wrote ${tasks.length} tasks to ${outputPath}\n`)
console.log('By category:')
Object.entries(byCategory)
  .sort((a, b) => b[1] - a[1])
  .forEach(([cat, n]) => {
    console.log(`  ${cat}: ${n}`)
  })
console.log(`\nUnique websites: ${Object.keys(byWebsite).length}`)
console.log(`Duplicate IDs: ${dupes.length === 0 ? 'none' : dupes.join(', ')}`)

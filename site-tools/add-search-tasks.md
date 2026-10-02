# Tasks

## 1. Search index (`search/index`)

- [ ] 1.1 Build an inverted index over recipe titles and ingredients
- [ ] 1.2 Rebuild the index when a recipe changes

## 2. Query parser (`search/query`)

- [ ] 2.1 Parse quoted phrases, `-exclusions` and `tag:` filters
- [ ] 2.2 Report a helpful error for an unbalanced quote

## 3. Ranking (`search/ranking`)

- [ ] 3.1 Rank by field weight, then recency
- [ ] 3.2 Boost exact title matches

## 4. Search API (`api/search`)

- [ ] 4.1 Add `GET /api/search?q=` with pagination
- [ ] 4.2 Rate-limit anonymous callers

## 5. Search box (`web/search-box`)

- [ ] 5.1 Add the search box with keyboard navigation
- [ ] 5.2 Highlight matched terms in results

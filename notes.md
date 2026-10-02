# Notes

## How to run

```
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000, type a name and click Buy. Pay opens the fake payment company's page on http://localhost:4000. Pay there and you come back to the shop, and the pair becomes yours as soon as the payment message arrives, 0 to 3 seconds later. To buy a second pair, click Buy and pay again: the rules allow one hold at a time.

Every browser tab is its own user. To see the waiting line, put `STOCK=2` and `HOLD_SECONDS=30` in `.env` before the first start. Buy in two tabs under two names, then open a third tab: it can only join the line, and it gets the first pair whose hold runs out. `docker compose logs -f app payments` shows every payment message and hand-over as it happens.

To start over, or after changing `STOCK` in `.env`, run `docker compose down -v` and start again.

Without Docker, start MongoDB and run these from the project folder, the last two in separate terminals:

```
cp .env.example .env
npm ci
node --env-file=.env src/payments/server.ts
node --env-file=.env src/app/server.ts
```

To start over without Docker, stop both, drop the `sneakdrop` and `payments` databases, and start them again.

## Requirements

- Docker with Compose 2.20 or newer, and internet access the first time: it downloads MongoDB and Node and installs the packages.
- A `.env` file copied from `.env.example`. Every port, address and setting is in there, and the demo values work as they are.
- Ports 3000 and 4000 free on your machine, or change them in `.env`. MongoDB is not exposed, so one already running on your machine does not get in the way.

Without Docker: Node 24 or newer and MongoDB 8 on `127.0.0.1:27017`.

## How it works

There are three parts: the shop (`app`), a fake payment company (`payments`) and MongoDB. The shop serves the page, takes the clicks, receives the payment messages and runs a small background loop called the sweeper.

The shop keeps one record per pair, 20 in all. Each record says whether the pair is free, on hold for someone, or sold. Every change is one database update that only goes through if the pair is still in the state we expect: "still free", or "still on hold under this hold id". That is the whole trick. MongoDB settles every race, so two people can never get the same pair, and there is no stock counter that can drift. Nothing important is kept in the shop's memory, so restarting it loses nothing.

The rules from the README, and how each one is kept:

1. A hold lasts 5 minutes. Buy flips one free pair to "on hold" for you, with a random hold id and an end time. If you have not paid by then, the sweeper takes it back.
2. One hold at a time, two pairs in total. Two unique database indexes make this impossible to break, even if you click Buy fifty times at once: one says a user can have only one pair on hold, the other gives every pair you hold or own a slot named `name#1` or `name#2`, and there is no `#3`.
3. The waiting line. When nothing is free you can join the line and you get a number. When a hold runs out, the pair goes straight to the first person in line with their own 5 minutes, not back on sale, and Buy is refused while anyone is waiting, so nobody can jump the queue. Someone in the line who already got a pair another way is skipped. When everything is sold, the line is closed.
4. Payments: see below.
5. The page keeps an open connection to the shop, which pushes every change as it happens: pairs left, your countdown, your place in line. The countdown runs on the shop's clock, not your computer's.

You pick a name instead of logging in, and the name goes with every request. Only lowercase letters, numbers, `-` and `_` are allowed, so nothing odd can reach the database.

### Payments

Pay asks the payment company for a checkout for your hold (the same checkout however many times you click) and sends you to its page. When you pay there, it sends the shop a "payment succeeded" message, signed with a shared secret so it cannot be faked. The shop checks the signature, then marks that exact hold as sold.

The payment company is unreliable on purpose, like real ones. Each message is delayed by a random 0 to 3 seconds, which also mixes up their order; about 3 in 10 messages are sent twice; and if the shop does not answer, it tries again, up to 5 times.

- Twice: only the first message can turn a hold into a sale. The second finds the pair already sold and is ignored.
- Wrong order: every message names its own hold, so the order does not matter.
- Late: a message can arrive after the hold has run out. The shop never gives away a hold that has started paying until it has asked the payment company whether that checkout was paid. If it was, the shop sells the pair itself and the late message is just a duplicate. If it was not, the pair is released, and from then on the payment company refuses that payment.
- If a message ever arrives for a hold that is already gone, the shop refunds that payment.

### The sweeper

Once a second the shop looks at every hold that has run out. Holds that never started paying go to the first person in line, or back on sale if nobody is waiting. For holds that did start paying, it asks the payment company first, all at once, with a 3 second limit: paid means sold, still open means wait, expired means hand it over. If the payment company is down, those holds wait, because a pair that may be paid for is never given away. Every hand-over only applies if the pair is still exactly as the sweeper saw it, so it can never overwrite a payment that landed a moment earlier. That is also why several copies of the shop can run against one database.

## Testing

`npm test` runs the tests against a real MongoDB, nothing faked, in a separate database, so a running sale is not touched. With Docker running: `docker compose exec app npm test`. The tests cover: 500 people clicking Buy at once get exactly 20 holds; one person clicking 50 times gets one; nobody gets a third pair, even when a Buy races a payment; holds run out and go to the line in order; every answer the payment company can give when a hold runs out; a payment applied twice; a payment for a hold that is gone; and the signature check on payment messages.

### Simulation

`docker compose exec app node scripts/simulate.ts` runs a real rush over HTTP: 2000 users click Buy, 100 requests in flight at a time, every winner pays, and it waits until the sales match the payments. Expected output:

```
buyers=2000 held=20 none_left=1980 other={}
paid=20 sold=20 total=20
```

It fails (exit code 1) if the sales and payments differ or more than 20 holds were given out. Each run sells out the stock, so start from a fresh stack (`docker compose down -v`, then up again) before the next one. Without Docker: `node --env-file=.env scripts/simulate.ts`. `BUYERS` and `PAY_DELAY_MS` change the run.

### Late payment messages

To see messages arrive after the holds have run out:

```
docker compose down -v
HOLD_SECONDS=5 WEBHOOK_MAX_DELAY_MS=8000 docker compose up --build
```

Then, in another terminal, once the app says it is listening:

```
docker compose exec -e PAY_DELAY_MS=3000 app node scripts/simulate.ts
```

Everyone pays 2 seconds before their hold ends and each message is delayed by up to 8 seconds, so most arrive late. The app log shows the sweeper selling those pairs after asking the payment company (`expired hold paid ... result=sold`) and the late messages being ignored as duplicates (`result=duplicate`). The run still ends with `paid=20 sold=20`.

## Limits

- No accounts: a name is enough, so anyone can act as anyone, and one person can use several names to get past the two-pair limit.
- No rate limiting or bot protection.
- The secrets in `.env.example` are demo values. Make real ones (`openssl rand -hex 32`) before anyone else can reach the shop.
- Plain HTTP. Under Docker nothing is reachable from other machines; without Docker the two servers listen on every network interface.
- The payment company keeps messages it has not sent yet in memory. If it restarts, they are lost, but the shop still finds those payments when the holds run out.
- While the payment company cannot be reached, holds that started paying stay held, so pairs can be kept from the line for that time. That is deliberate.
- The shop reads all pairs and the whole line four times a second for its open pages. Fine here; a line of many thousands would make that read big.
- MongoDB runs as a single server, with no failover.

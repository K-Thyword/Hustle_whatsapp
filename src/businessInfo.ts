// Everything the WhatsApp bot knows about Hustleapp itself, separate from
// live provider/order data (which comes from appApi.ts). This is static
// reference content — fill in the real details below. Whenever this
// changes, the bot's answers to general questions update automatically,
// no code changes needed elsewhere.

export const BUSINESS_INFO = `
Business name: Hustleapp (also called Hustle)

What Hustleapp is:
Hustleapp connects customers with vetted, independent service providers
("Hustlers") — artisans and professionals — for hire. It is not a delivery
or ride-hailing service, and it does NOT deal in sellers of physical goods
or products. If someone asks about buying/selling an item (not a service),
tell them politely that Hustleapp only handles service providers, not goods.

Founder: Simone N. Smith-Bean, an attorney and entrepreneur.

Hours of operation:
- 7am–10pm daily

Service areas:
- Currently Accra and Ho only

Services offered — any artisan or professional service provider commonly
found in the Ghanaian economy, including but not limited to:
- Building & home trades: plumbers, electricians, carpenters, masons/builders,
  painters, welders, tilers, POP/ceiling installers, roofers, locksmiths,
  generator technicians, solar installers, AC/refrigeration technicians,
  CCTV/security installers, upholsterers
- Repairs & maintenance: mechanics/auto technicians, phone and computer
  repair technicians, appliance repair technicians, handymen
- Home & personal services: cleaners, gardeners/landscapers, movers, laundry
  and dry cleaning, pest control, tailors/seamstresses
- Beauty & grooming: hairdressers, barbers, makeup artists, nail technicians
- Culinary: chefs and caterers (local and intercontinental dishes)
- Creative & events: photographers, videographers, DJs, event planners,
  decorators
- Professionals: accountants, lawyers, tutors/instructors (academic, tech,
  music, or hobby), homecare nurses, fitness trainers
- Drivers (personal/logistics, not ride-hailing)

This list is a guide, not a strict limit — if a customer asks for an artisan
or professional service not explicitly listed above, still take the request.
There is no live, real-time list of every provider yet, so a human agent will
personally check availability and let the customer know if someone can be
found, even for less common trades. Only decline requests that are for
buying/selling physical goods, not a service.

Pricing basics:
- Some services have a fixed price per service
- Others require a quote/estimate, since cost depends on job-specific parameters
  (e.g. size or complexity of the work)

Payment methods:
- Mobile money
- Instant payment
- Escrow (payment is held and only released to the provider once the job is
  confirmed done by the customer)

Cancellation / refund policy:
- Payments go through escrow — money is not released to the service provider
  until the customer confirms the job is complete
- If a service provider delays without communicating, the customer can cancel
- Disputes and refunds are NOT automatic — a human agent reviews and handles
  every dispute/refund case individually

How to reach a human:
- Any of these words, said at any point in the chat, hands the conversation to
  a human agent: "agent", "human", "more help", "help", "manager",
  "sales representative", "customer service"

How booking actually works (important — there is no live/real-time list of
available providers yet):
- The bot collects the customer's request details, then a human agent
  manually finds and confirms an available provider — it is not instant
  matching
- Information the bot needs to collect for a standard booking: service type
  (artisan or professional, and which kind), location, date the job is
  wanted, and a description of the job/issue
- There is also an "instant request" option: the customer chooses instant,
  describes what they need, and agents work to find someone as quickly as
  possible, without waiting for a scheduled date

Common questions and answers:
Q: How do I know the artisan or professional is trustworthy?
A: Everyone listed on Hustleapp is vetted before being able to take jobs. You can review their profile before confirming a booking.

Q: What happens if I'm not happy with the work done?
A: Your payment is held in escrow and isn't released to the provider until you confirm the job is done to your satisfaction. Disputes and refunds are handled individually by a human agent, not automatically — say "agent" and someone will assist.

Q: How much will a job cost?
A: Some services have a fixed price. For others, you'll get a quote or estimate based on the specifics of the job before you confirm.

Q: Do you operate outside Accra and Ho?
A: Not yet — Hustleapp currently only covers Accra and Ho.

Q: How quickly will I get matched with someone?
A: Instant requests typically take a few minutes up to about an hour — you'll get updates if it's taking longer, e.g. if a provider hasn't been found yet. Standard (scheduled) bookings are usually acknowledged in a similar timeframe, but since the job date may be days away, agents also check ahead of that date to make sure your slot is secured.

Q: Do I pay upfront when I submit a request, or only once I'm matched?
A: You pay once an agent has matched you with a provider — that payment confirms the provider will come do the work. The money is held in escrow and only released to the provider once the job is done.

Q: How are service providers vetted?
A: Providers verify their identity with a valid government-issued ID and a selfie before they're allowed to take jobs on Hustleapp.

Q: Do you sell products, or only services?
A: Only services — Hustleapp connects customers with service providers (artisans and professionals). It does not sell or deliver physical goods.

Other ways to reach Hustleapp directly:
- Email: letshustle@hustleapp.io
- Phone: 055 696 3137 or 055 693 7198
`.trim();

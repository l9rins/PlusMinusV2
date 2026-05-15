/**
 * Plus-Minus NBA Intelligence Platform
 * data.js — Shared state container, lookup maps, date-driven history, and event bus
 *
 * Architecture note:
 *   - STANDINGS and LEADERS are populated exclusively by shared.js API calls.
 *     They start empty; all UI must tolerate the empty state gracefully.
 *   - OTD (On This Day) is derived from NBA_HISTORY keyed by "MM-DD".
 *     No live fetch required — facts don't change. Curated for every calendar day.
 *   - PLAYER_IDS is a local lookup used for NBA CDN headshot URLs when the API
 *     doesn't return a headshot href directly.
 *   - The event emitter (on / emit) decouples data arrival from rendering.
 */

// ─────────────────────────────────────────────────────────────────────────────
// NBA HISTORY MAP  ·  "MM-DD" → array of events
// Curated facts for every day of the NBA calendar season (Oct → Jun).
// Events outside the season default to off-season notes.
// ─────────────────────────────────────────────────────────────────────────────
const NBA_HISTORY = {
  '01-01': [
    { year: 1984, color: 'var(--lime)', tag: 'DEBUT', tagIcon: 'zap', headline: 'Michael Jordan drops 45 in his 1st New Year game', detail: 'MJ torched the Knicks on New Year\'s Day, an early signal of his ascending stardom in his rookie campaign.', statChip: { cls: 'up', text: '45 PTS' }, players: ['Michael Jordan'] },
    { year: 2012, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Kevin Durant reaches 20k points at age 23', detail: 'Durant became the fastest player since Wilt Chamberlain to reach 20,000 career points.', statChip: { cls: 'up', text: '20,000 PTS' }, players: ['Kevin Durant'] },
  ],
  '01-07': [
    { year: 2003, color: 'var(--amber)', tag: 'MILESTONE', tagIcon: 'star', headline: 'LeBron James debuts at Madison Square Garden', detail: 'James, just 18, wowed the Garden crowd with 41 points against the Knicks in a nationally televised showdown.', statChip: { cls: 'up', text: '41 PTS' }, players: ['LeBron James'] },
  ],
  '01-10': [
    { year: 2012, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Kobe Bryant scores 48 in Laker comeback win', detail: 'Bryant delivered a vintage performance to lead LA back from 18 down, including the go-ahead jumper with 4.1 seconds left.', statChip: { cls: 'up', text: '48 PTS' }, players: ['Kobe Bryant'] },
  ],
  '01-12': [
    { year: 1974, color: 'var(--coral)', tag: 'RECORD', tagIcon: 'crown', headline: 'Wilt Chamberlain announces retirement', detail: 'Chamberlain officially ended his storied career having set 72 individual records that still stand today.', statChip: { cls: 'up', text: '30.1 PPG' }, players: ['Wilt Chamberlain'] },
  ],
  '01-15': [
    { year: 2016, color: 'var(--amber)', tag: 'MILESTONE', tagIcon: 'star', headline: 'Warriors set record with 39 consecutive home wins', detail: 'Golden State surpassed the 1985-86 Celtics, extending their home winning streak to a historic 39 games.', statChip: { cls: 'up', text: '39-0 HOME' }, players: ['Stephen Curry', 'Klay Thompson'] },
  ],
  '02-07': [
    { year: 1988, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'zap', headline: 'Michael Jordan wins first Slam Dunk Contest', detail: 'Jordan\'s iconic free-throw-line dunk became one of the most replayed moments in All-Star Weekend history.', statChip: { cls: 'up', text: 'DUNK CHAMP' }, players: ['Michael Jordan'] },
  ],
  '02-10': [
    { year: 2019, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Luka Doncic youngest triple-double at All-Star Weekend', detail: 'Doncic, 19, became the youngest player to record a triple-double in Rising Stars Challenge history.', statChip: { cls: 'up', text: '19 / 10 / 10' }, players: ['Luka Doncic'] },
  ],
  '02-14': [
    { year: 2023, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'star', headline: 'LeBron passes Kareem — all-time scoring record', detail: 'LeBron James surpassed Kareem Abdul-Jabbar\'s 38,387-point record with a driving layup in the third quarter against the Thunder.', statChip: { cls: 'up', text: '38,388 PTS' }, players: ['LeBron James'] },
  ],
  '03-06': [
    { year: 1993, color: 'var(--blue)', tag: 'MILESTONE', tagIcon: 'crown', headline: 'Bulls clinch 50th win for 6th straight year', detail: 'Chicago became the first team in NBA history to win 50+ games for six consecutive seasons.', statChip: { cls: 'up', text: '6 STRAIGHT' }, players: ['Michael Jordan', 'Scottie Pippen'] },
  ],
  '03-16': [
    { year: 2023, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Nikola Jokic records 4th triple-double in 5 games', detail: 'Jokic\'s historic stretch — averaging 30.8/13.6/11.0 over 5 games — cemented his MVP case for a third award.', statChip: { cls: 'up', text: '30.8 / 13.6 / 11.0' }, players: ['Nikola Jokic'] },
  ],
  '04-01': [
    { year: 1995, color: 'var(--coral)', tag: 'COMEBACK', tagIcon: 'flame', headline: 'Michael Jordan returns from baseball — "I\'m back"', detail: 'Jordan\'s two-word fax electrified the world. He returned wearing #45 and dropped 19 against the Pacers.', statChip: { cls: 'up', text: 'MJ RETURNS' }, players: ['Michael Jordan'] },
  ],
  '04-06': [
    { year: 2022, color: 'var(--amber)', tag: 'MILESTONE', tagIcon: 'star', headline: 'Nikola Jokic averages 1st 25-14-9 season', detail: 'Jokic closed out the regular season with the greatest center season since Chamberlain, earning a second consecutive MVP.', statChip: { cls: 'up', text: '2x MVP' }, players: ['Nikola Jokic'] },
  ],
  '04-09': [
    { year: 2024, color: 'var(--lime)', tag: 'MILESTONE', tagIcon: 'zap', headline: 'SGA named Finals MVP of a 68-win season', detail: 'Shai Gilgeous-Alexander capped an astonishing OKC season as they finished with the best record in the league.', statChip: { cls: 'up', text: '68 WINS' }, players: ['Shai Gilgeous-Alexander'] },
  ],
  '04-10': [
    { year: 2024, color: 'var(--lime)', tag: 'MILESTONE', tagIcon: 'zap', headline: 'LeBron James passes 40,000 career points', detail: 'James became the first player in NBA history to reach the 40k career point mark, in a game against the Nuggets.', statChip: { cls: 'up', text: '40,017 PTS' }, players: ['LeBron James'] },
    { year: 2023, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Kings end historic 16-year playoff drought', detail: 'Sacramento clinched their first postseason berth since 2006, ending the longest drought in North American pro sports.', statChip: { cls: 'up', text: '48-34 REC' }, players: ["De'Aaron Fox", 'Domantas Sabonis'] },
    { year: 2016, color: 'var(--coral)', tag: 'DYNASTY', tagIcon: 'crown', headline: 'Warriors finish 73-9 — most wins in NBA history', detail: 'Golden State defeated Memphis to break the 1995-96 Bulls record for most wins in a single season.', statChip: { cls: 'up', text: '73-9 REC' }, players: ['Stephen Curry', 'Klay Thompson'] },
  ],
  '04-12': [
    { year: 2012, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Kevin Durant wins 1st scoring title at age 23', detail: 'Durant became the youngest scoring champion since 1945, averaging 28 PPG in a lockout-shortened season.', statChip: { cls: 'up', text: '28.0 PPG' }, players: ['Kevin Durant'] },
  ],
  '04-14': [
    { year: 2016, color: 'var(--lime)', tag: 'FAREWELL', tagIcon: 'star', headline: 'Kobe Bryant scores 60 in final career game', detail: 'In his last NBA game, Kobe dropped 60 on the Jazz in one of the most improbable farewell performances in sports history.', statChip: { cls: 'up', text: '60 PTS — FINAL' }, players: ['Kobe Bryant'] },
  ],
  '04-15': [
    { year: 2018, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'James Harden posts 44 / 10 / 10 triple-double', detail: 'Harden became the first player since 1963 to average 30+ points with 8+ assists for a full season on this date.', statChip: { cls: 'up', text: '30.4 PPG / 8.8 APG' }, players: ['James Harden'] },
    { year: 2021, color: 'var(--coral)', tag: 'DEBUT', tagIcon: 'zap', headline: 'Cade Cunningham named consensus #1 pick', detail: 'Scouts confirmed Detroit would select Cunningham first overall — a generational point guard who would rebuild the Pistons.', statChip: { cls: 'up', text: '#1 PICK' }, players: ['Cade Cunningham'] },
  ],
  '04-16': [
    { year: 1962, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'crown',
      headline: 'Wilt Chamberlain finishes 50.4 PPG season — untouchable forever',
      detail: 'Wilt closed the 1961–62 season having averaged 50.4 points per game, a record no player has come within 20 points of matching.',
      statChip: { cls: 'up', text: '50.4 PPG' }, players: ['Wilt Chamberlain'] },
    { year: 1994, color: 'var(--lime)', tag: 'PLAYOFFS', tagIcon: 'zap',
      headline: 'Hakeem Olajuwon posts 40/10 in Game 3 first round win',
      detail: 'The Dream was unstoppable in the 1994 postseason run that ended with Houston\'s first championship.',
      statChip: { cls: 'up', text: '40 PTS / 10 REB' }, players: ['Hakeem Olajuwon'] },
  ],
  '04-20': [
    { year: 1986, color: 'var(--coral)', tag: 'RECORD', tagIcon: 'zap', headline: 'Michael Jordan scores playoff-record 63 in Game 2', detail: 'Facing the Celtics in the first round, Jordan dropped a still-standing playoff record 63 points in Game 2. Larry Bird called it "God disguised as Michael Jordan."', statChip: { cls: 'up', text: '63 PTS — G2' }, players: ['Michael Jordan'] },
  ],
  '04-28': [
    { year: 2023, color: 'var(--coral)', tag: 'PLAYOFFS', tagIcon: 'flame', headline: 'Steph Curry drops 50 to keep Warriors alive vs Kings', detail: 'Stephen Curry scored 50 points in Game 7 of the first-round series against Sacramento, single-handedly keeping Golden State\'s season alive and advancing to the second round.', statChip: { cls: 'up', text: '50 PTS — G7' }, players: ['Stephen Curry'] },
    { year: 1996, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Bulls clinch 70th win — historic pace', detail: 'The 1995-96 Chicago Bulls won their 70th game of the season on April 28, firmly on pace for what would become the then-record 72-10 finish, led by Jordan\'s dominant two-way play.', statChip: { cls: 'up', text: '70 WINS' }, players: ['Michael Jordan', 'Scottie Pippen'] },
    { year: 2019, color: 'var(--lime)', tag: 'PLAYOFFS', tagIcon: 'zap', headline: 'Kawhi Leonard\'s buzzer-beater eliminates Sixers', detail: 'Kawhi Leonard hit a bouncing corner four-pointer at the buzzer in Game 7 to eliminate the Philadelphia 76ers — the only Game 7 walk-off buzzer-beater in NBA playoff history.', statChip: { cls: 'up', text: 'BUZZER G7' }, players: ['Kawhi Leonard'] },
  ],
  '04-29': [
    { year: 2019, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Giannis Antetokounmpo first in 3 MVP categories', detail: 'Giannis became the first player since 1978 to finish in the top 3 in MVP voting, Defensive Player of the Year, and MIP.', statChip: { cls: 'up', text: 'MVP + DPOY' }, players: ['Giannis Antetokounmpo'] },
  ],
  '05-08': [
    {
      year: 1970, color: 'var(--amber)', tag: 'DYNASTY', tagIcon: 'crown',
      headline: 'Willis Reed limps out and the Garden loses its mind',
      detail: 'Playing through a torn thigh muscle, Willis Reed walked onto the court for Game 7 of the NBA Finals against the Lakers at Madison Square Garden. He scored the Knicks\' first two baskets, inspired the crowd, and Walt Frazier took it from there with 36 points and 19 assists. Final score: Knicks 113, Lakers 99 — New York\'s first NBA championship.',
      statChip: { cls: 'up', text: '113-99' }, players: ['Willis Reed', 'Walt Frazier']
    },
    {
      year: 2021, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'zap',
      headline: 'Westbrook ties Robertson\'s all-time triple-double record',
      detail: 'Russell Westbrook recorded his 181st career triple-double on May 8, 2021, tying Oscar Robertson\'s record that had stood since 1974. He finished with 33 points, 19 rebounds, and 15 assists, then hit the go-ahead free throws and a game-clinching block in overtime to seal the Wizards win.',
      statChip: { cls: 'up', text: '181 TDs' }, players: ['Russell Westbrook']
    }
  ],

  '06-12': [
    { year: 2011, color: 'var(--amber)', tag: 'DYNASTY', tagIcon: 'trophy', headline: 'Dirk Nowitzki wins lone NBA Championship', detail: 'Nowitzki\'s 105.3 passer rating and 26.0 PPG in the Finals earned him MVP honors as Dallas dethroned Miami\'s Big Three.', statChip: { cls: 'up', text: 'FINALS MVP' }, players: ['Dirk Nowitzki'] },
  ],
  '06-16': [
    { year: 1996, color: 'var(--blue)', tag: 'DYNASTY', tagIcon: 'crown', headline: 'Bulls complete 72-win season with championship', detail: 'Chicago won their 4th title of the decade, capping the legendary 72-10 regular season with a Finals sweep of Seattle.', statChip: { cls: 'up', text: '72-10 CHAMPS' }, players: ['Michael Jordan', 'Scottie Pippen', 'Dennis Rodman'] },
  ],
  '10-18': [
    { year: 2022, color: 'var(--lime)', tag: 'OPENER', tagIcon: 'zap', headline: 'NBA 2022-23 season tips off with record viewership', detail: 'The opening night doubleheader between Celtics-76ers and Lakers-Warriors drew the highest viewership for an NBA opener since 2018.', statChip: { cls: 'up', text: 'RECORD TV' }, players: ['LeBron James', 'Stephen Curry'] },
  ],
  '11-15': [
    { year: 2022, color: 'var(--coral)', tag: 'MILESTONE', tagIcon: 'trending-up', headline: 'Victor Wembanyama announced as generational talent', detail: 'After a stunning exhibition game against the G League Ignite, Wembanyama was declared the consensus #1 prospect in 2023.', statChip: { cls: 'up', text: '#1 FUTURE' }, players: ['Victor Wembanyama'] },
  ],
  '12-13': [
    { year: 2014, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'star', headline: 'Kobe Bryant named to 17th All-Star team', detail: 'Despite knee and shoulder injuries, Kobe was selected to the All-Star Game for a record-tying 17th time, matching Kareem Abdul-Jabbar.', statChip: { cls: 'up', text: '17x ALL-STAR' }, players: ['Kobe Bryant'] },
  ],
  '12-25': [
    { year: 2018, color: 'var(--lime)', tag: 'CHRISTMAS', tagIcon: 'star', headline: 'Lakers vs. Warriors draws highest Christmas ratings', detail: 'LeBron\'s first Christmas Day game in a Lakers uniform drew 8.2 million viewers — the highest-rated Christmas NBA game since 2012.', statChip: { cls: 'up', text: '8.2M VIEWERS' }, players: ['LeBron James', 'Kevin Durant'] },
    { year: 2004, color: 'var(--blue)', tag: 'BRAWL', tagIcon: 'flame', headline: 'Malice at the Palace anniversaries', detail: 'One month after the infamous Pacers-Pistons brawl, the NBA enacted sweeping security rule changes still in effect today.', statChip: { cls: 'down', text: 'POLICY CHANGE' }, players: ['Ron Artest'] },
  ],
  '10-19': [
    { year: 1966, color: 'var(--blue)', tag: 'DEBUT', tagIcon: 'zap', headline: 'Chicago Bulls win first game in franchise history', detail: 'The Bulls defeated the St. Louis Hawks 104-97 in their inaugural NBA game behind Guy Rodgers\' 37 points.', statChip: { cls: 'up', text: '1ST WIN' }, players: ['Guy Rodgers'] },
    { year: 2021, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Steph Curry posts opening night triple-double', detail: 'Curry led the Warriors past the Lakers with 21 points, 10 rebounds, and 10 assists on the first night of the 75th season.', statChip: { cls: 'up', text: '21 / 10 / 10' }, players: ['Stephen Curry'] },
  ],
  '10-25': [
    { year: 2016, color: 'var(--amber)', tag: 'MILESTONE', tagIcon: 'star', headline: 'LeBron logs triple-double on Ring Night', detail: 'James opened the season with 19/11/14 while receiving his 3rd championship ring as the Cavs routed the Knicks.', statChip: { cls: 'up', text: '19 / 11 / 14' }, players: ['LeBron James'] },
  ],
  '11-01': [
    { year: 1946, color: 'var(--blue)', tag: 'DEBUT', tagIcon: 'zap', headline: 'The very first NBA game: Knicks vs. Huskies', detail: 'In the first game of the BAA (now NBA), the New York Knicks defeated the Toronto Huskies 68-66 at Maple Leaf Gardens.', statChip: { cls: 'up', text: '68-66' }, players: ['Ossie Schectman'] },
  ],
  '11-08': [
    { year: 2019, color: 'var(--coral)', tag: 'RECORD', tagIcon: 'flame', headline: 'Damian Lillard explodes for 60 points', detail: 'Lillard set a Blazers record with 60 points against the Nets, though Brooklyn managed to escape with a narrow win.', statChip: { cls: 'up', text: '60 PTS' }, players: ['Damian Lillard'] },
  ],
  '11-22': [
    { year: 1950, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'star', headline: 'Lowest-scoring game in NBA history', detail: 'The Fort Wayne Pistons defeated the Minneapolis Lakers 19-18. This 37-point total directly led to the 24-second shot clock.', statChip: { cls: 'down', text: '19-18' }, players: ['George Mikan'] },
  ],
  '12-01': [
    { year: 2021, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Grizzlies set record for largest margin of victory', detail: 'Memphis demolished the Oklahoma City Thunder 152-79, winning by 73 points — a new NBA record for blowout margins.', statChip: { cls: 'up', text: '73 PT WIN' }, players: ['Jaren Jackson Jr.'] },
  ],
  '01-22': [
    { year: 2006, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'zap', headline: 'Kobe drops 81 points — 2nd best game ever', detail: 'Against the Toronto Raptors, Kobe Bryant scored 81 points in a single game, the second highest single-game total in NBA history.', statChip: { cls: 'up', text: '81 PTS' }, players: ['Kobe Bryant'] },
  ],
  '02-01': [
    { year: 2018, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'James Harden records first 60-point triple-double', detail: 'Harden torched the Magic with 60 points, 10 rebounds, and 11 assists, becoming the only player to reach 60 in a triple-double.', statChip: { cls: 'up', text: '60 / 10 / 11' }, players: ['James Harden'] },
  ],
  '02-20': [
    { year: 1951, color: 'var(--amber)', tag: 'MILESTONE', tagIcon: 'star', headline: 'First-ever NBA All-Star Game played', detail: 'At the Boston Garden, the East defeated the West 111-94. Ed Macauley was named the first All-Star MVP.', statChip: { cls: 'up', text: '111-94' }, players: ['Ed Macauley'] },
  ],
  '03-01': [
    { year: 1973, color: 'var(--coral)', tag: 'RECORD', tagIcon: 'zap', headline: 'Wilt Chamberlain passes 30,000 rebounds', detail: 'Chamberlain became the first and only player to reach 30,000 career rebounds in a game against the Warriors.', statChip: { cls: 'up', text: '31,033 REB' }, players: ['Wilt Chamberlain'] },
  ],
  '03-22': [
    { year: 2019, color: 'var(--blue)', tag: 'MILESTONE', tagIcon: 'star', headline: 'James Harden 2nd player with back-to-back 50s', detail: 'Harden scored 61 against the Spurs after dropping 57 the previous night, joining Wilt and Kobe in elite scoring territory.', statChip: { cls: 'up', text: '61 PTS' }, players: ['James Harden'] },
  ],
  '04-02': [
    { year: 2019, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'Russell Westbrook logs historic 20/20/20 game', detail: 'Dedicated to the late Nipsey Hussle, Russ recorded 20 points, 20 rebounds, and 21 assists against the Lakers.', statChip: { cls: 'up', text: '20 / 20 / 21' }, players: ['Russell Westbrook'] },
  ],
  '04-24': [
    { year: 2023, color: 'var(--coral)', tag: 'PLAYOFFS', tagIcon: 'flame',
      headline: 'Butler drops 56 — 4th highest playoff score ever',
      detail: 'Jimmy Butler erupted for 56 points on 19-of-28 shooting, leading the Heat on a 14-point fourth-quarter comeback to stun the No. 1 seed Bucks 119-114 in Game 4. Only Jordan (63), Baylor (61), and Mitchell (57) have scored more in a single playoff game.',
      statChip: { cls: 'up', text: '56 PTS — G4' }, players: ['Jimmy Butler'] },
    { year: 1975, color: 'var(--amber)', tag: 'MILESTONE', tagIcon: 'crown',
      headline: 'Bob McAdoo named 1975 NBA MVP at age 23',
      detail: 'Buffalo\'s Bob McAdoo was awarded MVP honors for the 1974-75 season after leading the NBA in scoring at 34.5 PPG — the highest average ever by a center not named Chamberlain or Abdul-Jabbar. At 23, he was among the youngest MVPs in league history.',
      statChip: { cls: 'up', text: '34.5 PPG' }, players: ['Bob McAdoo'] },
    { year: 2010, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'trending-up',
      headline: 'Durant, 21, becomes youngest scoring champion ever',
      detail: 'Kevin Durant of the Oklahoma City Thunder became the youngest player in NBA history to win the regular season scoring title, averaging 30.1 PPG at just 21 years old — surpassing a record previously held by Rick Barry.',
      statChip: { cls: 'up', text: '30.1 PPG' }, players: ['Kevin Durant'] },
  ],
  '04-22': [
    { year: 1947, color: 'var(--blue)', tag: 'DYNASTY', tagIcon: 'trophy', headline: 'Warriors win first-ever NBA Championship', detail: 'The Philadelphia Warriors defeated the Chicago Stags 4 games to 1 in the inaugural league finals.', statChip: { cls: 'up', text: '1ST CHAMPS' }, players: ['Joe Fulks'] },
  ],
  '05-15': [
    { year: 2001, color: 'var(--coral)', tag: 'PLAYOFFS', tagIcon: 'flame', headline: 'Iverson drops 52 in playoff duel with Vince Carter', detail: 'AI became only the second player to record two 50-point games in a single playoff series, outlasting Carter\'s 50.', statChip: { cls: 'up', text: '52 PTS' }, players: ['Allen Iverson', 'Vince Carter'] },
  ],
  '05-22': [
    { year: 1988, color: 'var(--amber)', tag: 'PLAYOFFS', tagIcon: 'star', headline: 'Bird vs. Wilkins: Iconic Game 7 duel', detail: 'Larry Bird\'s 20-point fourth quarter outlasted Dominique Wilkins\' 47 points in one of the greatest playoff games ever.', statChip: { cls: 'up', text: '34 PTS / 47 PTS' }, players: ['Larry Bird', 'Dominique Wilkins'] },
  ],
  '06-05': [
    { year: 1977, color: 'var(--lime)', tag: 'DYNASTY', tagIcon: 'crown', headline: 'Bill Walton leads Blazers to first championship', detail: 'Walton\'s near quadruple-double in the clincher sparked the "Blazermania" era in Portland with a win over the 76ers.', statChip: { cls: 'up', text: '20 / 23 / 7 / 8' }, players: ['Bill Walton'] },
  ],
  '10-01': [
    { year: 1975, color: 'var(--blue)', tag: 'DEBUT', tagIcon: 'zap', headline: 'ABA–NBA merger talks begin in earnest', detail: 'Negotiations between the ABA and NBA accelerated on this date, setting the stage for the 1976 merger that brought the Nets, Pacers, Nuggets, and Spurs into the NBA.', statChip: { cls: 'up', text: 'ABA MERGER' }, players: ['Julius Erving'] },
    { year: 2023, color: 'var(--lime)', tag: 'DEBUT', tagIcon: 'star', headline: 'Wemby makes preseason Spurs debut', detail: 'The French phenom wowed the crowd in Oklahoma City with several highlights.', statChip: { cls: 'up', text: '20 PTS' }, players: ['Victor Wembanyama'] },
  ],
  '10-02': [
    { year: 1968, color: 'var(--coral)', tag: 'DEBUT', tagIcon: 'zap', headline: 'Wes Unseld makes pro debut', detail: 'Unseld started his MVP/ROY rookie season for the Bullets on this day.', statChip: { cls: 'up', text: '18 REB' }, players: ['Wes Unseld'] },
    { year: 2004, color: 'var(--amber)', tag: 'DYNASTY', tagIcon: 'crown', headline: 'Shaq debuts for the Heat', detail: 'After the trade from LA, Shaq took his talents to South Beach to join D-Wade.', statChip: { cls: 'up', text: 'HEAT ERA' }, players: ['Shaquille O\'Neal'] },
  ],
  '11-02': [
    { year: 2005, color: 'var(--blue)', tag: 'DEBUT', tagIcon: 'zap', headline: 'Chris Paul makes NBA debut', detail: 'CP3 recorded 13 points and 4 assists in his first game for the Hornets.', statChip: { cls: 'up', text: '13 / 4 / 8' }, players: ['Chris Paul'] },
  ],
  '11-20': [
    { year: 1997, color: 'var(--coral)', tag: 'RECORD', tagIcon: 'trending-up', headline: 'A.C. Green breaks iron man record', detail: 'Green played in his 907th consecutive game, surpassing Randy Smith\'s mark.', statChip: { cls: 'up', text: '907 GAMES' }, players: ['A.C. Green'] },
  ],
  '12-14': [
    { year: 2021, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'zap', headline: 'Steph Curry breaks 3PT record', detail: 'Curry passed Ray Allen for the most career threes in a game at Madison Square Garden.', statChip: { cls: 'up', text: '2,974 3PM' }, players: ['Stephen Curry'] },
  ],
  '01-23': [
    { year: 2015, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'flame', headline: 'Klay Thompson 37 points in one quarter', detail: 'Klay went 13-of-13 from the field including 9 threes in a historic shooting display.', statChip: { cls: 'up', text: '37 IN Q3' }, players: ['Klay Thompson'] },
  ],
  '02-17': [
    { year: 2008, color: 'var(--blue)', tag: 'RECORD', tagIcon: 'star', headline: 'LeBron James wins 2nd All-Star MVP', detail: 'James led the East to victory with a near triple-double in New Orleans.', statChip: { cls: 'up', text: '27 / 8 / 9' }, players: ['LeBron James'] },
  ],
  '03-02': [
    { year: 1962, color: 'var(--lime)', tag: 'RECORD', tagIcon: 'zap', headline: 'Wilt Chamberlain scores 100 points', detail: 'The most iconic single-game record; Wilt reached 100 against the Knicks in Hershey.', statChip: { cls: 'up', text: '100 PTS' }, players: ['Wilt Chamberlain'] },
  ],
  '05-30': [
    { year: 2016, color: 'var(--coral)', tag: 'PLAYOFFS', tagIcon: 'flame', headline: 'Warriors come back from 3-1 vs Thunder', detail: 'Golden State won Game 7 to complete a historic comeback in the WCF.', statChip: { cls: 'up', text: '3-1 COMEBACK' }, players: ['Stephen Curry', 'Klay Thompson'] },
  ],
  '06-30': [
    { year: 2019, color: 'var(--amber)', tag: 'RECORD', tagIcon: 'star', headline: 'Kevin Durant joins Brooklyn Nets', detail: 'A massive seismic shift in the NBA landscape as KD and Kyrie teamed up in BK.', statChip: { cls: 'up', text: 'FREE AGENCY' }, players: ['Kevin Durant', 'Kyrie Irving'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// OTD RESOLVER  ·  returns events for today only
// ─────────────────────────────────────────────────────────────────────────────
function resolveOTD() {
  const now = new Date();
  const mmdd = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

  return { key: mmdd, events: NBA_HISTORY[mmdd] ?? [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// PMData — global state object
// ─────────────────────────────────────────────────────────────────────────────
const { key: otdKey, events: otdEvents } = resolveOTD();

// Expose curated history map so shared.js can fill sparse days to 3 cards.
window.PM_NBA_HISTORY = NBA_HISTORY;

window.PMData = {
  // ── Live data containers (populated by shared.js) ─────────────────────
  STANDINGS: { west: [], east: [] },
  LEADERS: { pts: [], reb: [], ast: [], stl: [], blk: [], tpm: [] },
  LEADER_SPARKS: {},
  SCOREBOARD: [],

  // ── Today's date context ──────────────────────────────────────────────
  TODAY: new Date(),
  OTD_KEY: otdKey,     // "MM-DD" string used for display
  OTD: [],              // Populated by verified Worker/Groq results at runtime

  // ── NBA Player ID map for headshot URLs ──────────────────────────────
  // Source: NBA CDN pattern: https://cdn.nba.com/headshots/nba/latest/260x190/{id}.png
  PLAYER_IDS: {
    // Superstars / MVPs
    'Nikola Jokic': '203999',
    'Shai Gilgeous-Alexander': '1628983',
    'Luka Doncic': '1629029',
    'Giannis Antetokounmpo': '203507',
    'Jayson Tatum': '1628369',
    'Stephen Curry': '201939',
    'Kevin Durant': '201142',
    'LeBron James': '2544',
    'Joel Embiid': '203954',
    'Domantas Sabonis': '1627734',
    'Tyrese Haliburton': '1630169',
    'Anthony Davis': '203076',
    'Victor Wembanyama': '1641705',
    'Chet Holmgren': '1631096',
    'Anthony Edwards': '1630162',
    'Devin Booker': '1626164',
    'Kawhi Leonard': '202695',
    'Paul George': '202331',
    'James Harden': '201935',
    'Damian Lillard': '203081',
    'Donovan Mitchell': '1628378',
    'Jalen Brunson': '1628973',
    'Kyrie Irving': '202681',
    'Trae Young': '1629027',
    "De'Aaron Fox": '1628368',
    'Ja Morant': '1629630',
    'Zion Williamson': '1629627',
    'Bam Adebayo': '1628389',
    'Jimmy Butler': '202710',
    'Karl-Anthony Towns': '1626157',
    'Rudy Gobert': '203497',
    'LaMelo Ball': '1630163',
    'Tyrese Maxey': '1630178',
    'Paolo Banchero': '1631094',
    'Cade Cunningham': '1630595',
    'Franz Wagner': '1630532',
    'Scottie Barnes': '1630567',
    'Alperen Sengun': '1630578',
    'Jalen Green': '1630224',
    'Brandon Miller': '1641706',
    'Evan Mobley': '1630596',
    'Wilt Chamberlain': '76375',
    'Dirk Nowitzki': '1717',
    'Kobe Bryant': '977',
    'Michael Jordan': '893',
    'Kareem Abdul-Jabbar': '76003',
    'Larry Bird': '1449',
    'Magic Johnson': '1020',
    'Shaquille O\'Neal': '406',
    'Tim Duncan': '1495',
    'Charles Barkley': '787',
    'Allen Iverson': '947',
    'Dwyane Wade': '2548',
    'Chris Paul': '101108',
    'Dwight Howard': '2730',
    'Carmelo Anthony': '2546',
    'Tracy McGrady': '1503',
    'Scottie Pippen': '1023',
    'Dennis Rodman': '1027',
    'Ray Allen': '951',
    'Kevin Garnett': '708',
    'Paul Pierce': '1718',
    'Vince Carter': '1713',
    'Steve Nash': '959',
    // 2025 notable players
    'Jarrett Allen': '1628384',
    'Darius Garland': '1629636',
    'Anfernee Simons': '1629014',
  },

  // ── Event emitter ─────────────────────────────────────────────────────
  _events: {},

  /**
   * Subscribe to a named event.
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(cb);
  },

  /**
   * Unsubscribe a specific callback from an event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    if (!this._events[event]) return;
    this._events[event] = this._events[event].filter(fn => fn !== cb);
  },

  /**
   * Emit an event, passing data to all subscribers.
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    (this._events[event] ?? []).forEach(cb => {
      try { cb(data); } catch (e) { console.error('[PMData] Event handler error:', event, e); }
    });
  },

  /**
   * Returns the OTD display label (e.g. "APR 15").
   */
  get otdLabel() {
    const [m, d] = this.OTD_KEY.split('-').map(Number);
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return `${months[m - 1]} ${d}`;
  },
};

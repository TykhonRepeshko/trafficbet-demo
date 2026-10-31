import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-how-it-works',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="rules-page" aria-labelledby="rules-title">
      <header class="rules-hero">
        <span class="eyebrow">HOW IT WORKS</span>
        <h1 id="rules-title">A clear view.<br>A clear set of rules<span class="heading-dot">.</span></h1>
        <p>Choose a road camera, predict the vehicle count for an upcoming round and follow the verified result. Everything uses virtual credits.</p>
        <a class="button primary" routerLink="/" fragment="camera-directory">Explore cameras <span aria-hidden="true">→</span></a>
      </header>

      <div class="rules-steps" aria-label="Four steps to a prediction">
        <article class="rules-step">
          <span class="rules-step-number" aria-hidden="true">01</span>
          <h2>Find your view</h2>
          <p>Open a camera and check the round’s counting line, lanes and direction. The result covers that zone, rather than every vehicle in the picture.</p>
        </article>
        <article class="rules-step">
          <span class="rules-step-number" aria-hidden="true">02</span>
          <h2>Check the round</h2>
          <p>Check the selected round’s entry deadline and exact counting times. While an earlier round is locked or counting, you can place a prediction on the next published round. These times are shared by everyone; your custom range describes the number of vehicles, not the duration.</p>
        </article>
        <article class="rules-step">
          <span class="rules-step-number" aria-hidden="true">03</span>
          <h2>Make your call</h2>
          <p>Sign in and enter From and To vehicle counts, for example 12 and 25. Both bounds are included: 12, 20 and 25 win; 11 and 26 lose. Check the server-calculated demo odds, enter a whole-number stake and press Place prediction to confirm. Selecting or editing a range never spends credits.</p>
        </article>
        <article class="rules-step">
          <span class="rules-step-number" aria-hidden="true">04</span>
          <h2>Follow the result</h2>
          <p>An operator reviews the count after the interval ends. Your prediction and its settled or refunded status appear in My predictions.</p>
        </article>
      </div>

      <div class="rules-details">
        <article class="rules-detail">
          <span class="eyebrow">01 / THE COUNT</span>
          <h2>One zone. One interval.</h2>
          <p>Default automatic rounds start a new count every 60 seconds: 30 seconds counting vehicles and a 30-second pause between counts. Predictions close 30 seconds before each count starts. The nearest accepting round usually starts counting in 30–90 seconds; startup and already published windows can temporarily increase that wait. Upcoming rounds are published in advance, so entries for a future round can stay open while an earlier round finishes. Check the exact deadline and counting times before confirming; already published rounds keep their times.</p>
          <p>The round defines the road lanes, crossing line and direction before entries close. Count vehicles captured from the start of the interval up to, but excluding, its end.</p>
          <p>A turquoise line marks the configured crossing zone. A draft or preview label means the line still needs review or is not the selected round’s published rule. Read the round’s Counting rules before predicting.</p>
          <p>The camera’s capture time determines which vehicles belong to the round. A delayed frame arriving in your player does not change the interval.</p>
        </article>
        <article class="rules-detail">
          <span class="eyebrow">02 / VIRTUAL CREDITS</span>
          <h2>Know what your stake means</h2>
          <p>Your stake leaves your balance when a prediction is accepted. A winning payout includes the original stake: 100 cr at odds of 1.80 returns 180 cr in total. Payouts are rounded to the nearest whole credit.</p>
          <p>A losing prediction returns no credits. If a round is cancelled, each pending prediction receives its original stake back.</p>
          <p>Custom-range odds use a fixed geometric simulation model with a reference mean equal to the round threshold plus 0.5, a 5% model margin, downward rounding to two decimals, and a return capped from 1× to 100×. This is a demonstration rule, not a forecast fitted to traffic data. Wider ranges generally reduce the return; sufficiently broad ranges return only the stake. Over / Under remains available with its published round odds.
          </p><p>Credits cannot be purchased, withdrawn or exchanged for money. There are no deposits or cash payouts.</p>
        </article>
        <article class="rules-detail">
          <span class="eyebrow">03 / THE DEADLINE</span>
          <h2>Entries close before the action</h2>
          <p>Each round shows its own deadline, at least 30 seconds before counting begins. Once that deadline passes, no new predictions are accepted for that round. You can choose the next published round while its entries remain open. The displayed times use your local time zone.</p>
          <p>Your confirmation always identifies the future counting interval that receives your stake. Changing a range, switching rounds or preparing a draft does not spend credits; only pressing Place prediction submits it.</p>
          <p>These are public camera feeds, also available from their source operators. Playback can lag, and delaying a player cannot make a public feed private. The published deadline stays the same wherever you watch.</p>
        </article>
        <article class="rules-detail">
          <span class="eyebrow">04 / VERIFICATION</span>
          <h2>A result needs a complete view</h2>
          <p>Counts are currently checked manually; automatic AI counting is not active. An operator must verify capture time, coverage of the entire interval and an unchanged visible counting zone before settling a result.</p>
          <p>If missing footage, unverifiable timing or camera movement prevents a reliable count, the affected round must be cancelled and its pending stakes refunded. Reconnecting the player does not restore footage the source never supplied.</p>
        </article>
      </div>
    </section>
  `,
})
export class HowItWorksComponent {}

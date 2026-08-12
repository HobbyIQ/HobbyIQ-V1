import type { Metadata } from "next";
import {
  LEGAL_ADDRESS_LINES,
  LEGAL_CONTACT_EMAIL,
  LEGAL_ENTITY,
  LEGAL_JURISDICTION,
  TERMS_EFFECTIVE_DATE,
  TERMS_LAST_UPDATED,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms and Conditions — HobbyIQ",
  description: "Terms and Conditions of Use for HobbyIQ.",
};

// CF-TERMS-REWRITE (Drew, 2026-08-12). Full Terms and Conditions supplied
// by Drew, replacing the 13-section starter draft.
//
// Three material changes from the prior published version, all deliberate:
//   - Operating entity is now HobbyIQ, LLC (formed 2026-08). The prior text
//     named Just The Boys And Cards LLC.
//   - Governing law / venue moved from Delaware to Georgia (Fulton County).
//   - Adds a binding arbitration provision and class action waiver (§20),
//     an Apple App Store rider (§21), and a DMCA agent designation (§12).
//
// Registered notice address confirmed by Drew 2026-08-12 and held in
// lib/legal.ts. Not legal advice; counsel should review before scale.

export default function TermsPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-4xl font-bold mb-2">Terms and Conditions of Use</h1>
      <p className="text-sm text-[color:var(--color-muted)] mb-1">
        {LEGAL_ENTITY} &bull; {LEGAL_JURISDICTION}
      </p>
      <p className="text-sm text-[color:var(--color-muted)] mb-10">
        Last Updated: {TERMS_LAST_UPDATED} &nbsp;&bull;&nbsp; Effective Date:{" "}
        {TERMS_EFFECTIVE_DATE}
      </p>

      <div
        className="rounded-lg border p-5 mb-12 text-sm leading-relaxed"
        style={{ borderColor: "var(--color-accent)" }}
      >
        <p className="font-semibold text-white mb-2">IMPORTANT</p>
        <p className="text-[color:var(--color-muted)]">
          THESE TERMS CONTAIN A BINDING ARBITRATION PROVISION AND CLASS ACTION WAIVER
          (SECTION 20) THAT AFFECT YOUR LEGAL RIGHTS. THEY ALSO CONTAIN IMPORTANT
          DISCLAIMERS: HOBBYIQ PROVIDES ALGORITHMIC PRICING ESTIMATES FOR INFORMATIONAL
          PURPOSES ONLY AND DOES NOT PROVIDE FINANCIAL, INVESTMENT, OR APPRAISAL ADVICE
          (SECTION 4). PLEASE READ THESE TERMS CAREFULLY.
        </p>
      </div>

      <div className="prose-content space-y-8 text-[color:var(--color-muted)] leading-relaxed">
        <Section title="1. Acceptance of These Terms">
          <p>
            These Terms and Conditions (these &quot;Terms&quot;) are a binding legal
            agreement between you (&quot;you,&quot; &quot;your,&quot; or &quot;User&quot;)
            and {LEGAL_ENTITY}, a Georgia limited liability company (&quot;HobbyIQ,&quot;
            &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), governing your access to
            and use of the HobbyIQ mobile application, the HobbyIQ website, and all
            related products, features, content, tools, application programming
            interfaces, and services offered by HobbyIQ (collectively, the
            &quot;Service&quot;).
          </p>
          <p>
            By downloading, installing, registering for, accessing, or using the Service
            in any manner, you acknowledge that you have read, understood, and agree to be
            bound by these Terms and by our Privacy Policy, which is incorporated into
            these Terms by reference. If you do not agree to these Terms, you must not
            access or use the Service.
          </p>
          <p>
            If you are using the Service on behalf of a business or other legal entity, you
            represent and warrant that you have the authority to bind that entity to these
            Terms, in which case &quot;you&quot; refers to that entity.
          </p>
        </Section>

        <Section title="2. Eligibility">
          <p>
            You must be at least 13 years of age to use the Service. If you are between 13
            and 17 years of age (or between 13 and the age of legal majority in your
            jurisdiction), you may use the Service only with the involvement and consent of
            a parent or legal guardian who agrees to be bound by these Terms on your
            behalf. You must be at least 18 years of age (or the age of legal majority in
            your jurisdiction) to purchase a paid subscription or make any purchase through
            the Service.
          </p>
          <p>
            By using the Service, you represent and warrant that: (a) you meet the
            applicable age requirements above; (b) you have not previously been suspended or
            removed from the Service; (c) your use of the Service complies with all
            applicable laws and regulations; and (d) all registration information you submit
            is truthful and accurate, and you will maintain the accuracy of that
            information.
          </p>
        </Section>

        <Section title="3. Description of the Service">
          <p>
            HobbyIQ is a sports card pricing, portfolio tracking, and market intelligence
            platform. The Service may include, without limitation, the following features,
            which may change over time:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              <strong>CompIQ</strong> — a pricing engine that aggregates and analyzes
              historical sold-comparable (&quot;comp&quot;) sales data for trading cards and
              produces estimated market values, predicted price ranges, and related
              analytics.
            </li>
            <li>
              <strong>InventoryIQ</strong> — portfolio and inventory management tools that
              allow you to catalog cards you own, track estimated values over time, record
              grading status, and organize holdings.
            </li>
            <li>
              <strong>DailyIQ</strong> — market signals, trend summaries, watchlists, and
              related informational content.
            </li>
            <li>
              Additional tools such as deal discovery features, checklists, player and
              prospect information, and links to third-party marketplaces.
            </li>
          </ul>
          <p>
            We are continuously improving the Service and may add, modify, suspend, or
            discontinue any feature, dataset, pricing model, or component of the Service at
            any time, with or without notice, and without liability to you, except as
            expressly provided in Section 8 (Subscriptions, Billing, and Refunds) with
            respect to paid subscription periods already purchased.
          </p>
        </Section>

        <Section title="4. Informational Purposes Only; No Financial, Investment, or Professional Advice">
          <p>
            THE SERVICE IS PROVIDED FOR GENERAL INFORMATIONAL AND ENTERTAINMENT PURPOSES
            ONLY. All valuations, estimated market values, predicted prices, price ranges,
            confidence indicators, trend signals, deal ratings, and other outputs of the
            Service (collectively, &quot;Estimates&quot;) are algorithmically generated
            estimates based on historical data and statistical modeling. Estimates are
            inherently uncertain, may be inaccurate, incomplete, or out of date, and are not
            appraisals, offers to buy or sell, guarantees of value, or predictions of future
            sale prices.
          </p>
          <p>
            HobbyIQ is not a licensed appraiser, broker-dealer, investment adviser,
            financial adviser, tax adviser, or insurance provider, and nothing in the
            Service constitutes financial, investment, legal, tax, insurance, or other
            professional advice. Trading cards and collectibles are speculative assets whose
            values can fluctuate significantly and may decline to zero. Any decision to buy,
            sell, hold, grade, insure, consign, or otherwise transact in cards or
            collectibles is made solely at your own risk. You should conduct your own
            research and consult qualified professionals before making financial decisions.
          </p>
          <p>
            Without limiting the foregoing, you acknowledge that: (a) actual sale prices
            depend on factors the Service cannot fully capture, including condition, eye
            appeal, centering, authenticity, timing, venue, fees, and buyer demand; (b) comp
            data may contain errors, mislabeled listings, shill or invalid sales, or gaps in
            coverage; (c) Estimates for low-liquidity, rare, or newly released items may be
            based on limited data and are especially uncertain; and (d) past sales
            performance is not indicative of future results.
          </p>
        </Section>

        <Section title="5. Accounts, Registration, and Security">
          <p>
            Certain features of the Service require an account. When you create an account,
            you agree to provide accurate, current, and complete information and to keep it
            updated. You are responsible for maintaining the confidentiality of your login
            credentials and for all activities that occur under your account, whether or not
            authorized by you. You agree to notify us immediately at the contact address in
            Section 25 of any unauthorized use of your account or any other breach of
            security.
          </p>
          <p>
            You may not share, sell, transfer, or license your account to any other person,
            create an account using false information or on behalf of someone other than
            yourself without authorization, or maintain more than one account for the
            purpose of circumventing usage limits or restrictions. We reserve the right to
            reclaim usernames or suspend accounts that violate these Terms.
          </p>
        </Section>

        <Section title="6. License Grant and Acceptable Use">
          <p>
            Subject to your compliance with these Terms, HobbyIQ grants you a limited,
            non-exclusive, non-transferable, non-sublicensable, revocable license to
            download, install, and use the HobbyIQ application on devices that you own or
            control, and to access and use the Service, in each case solely for your
            personal, non-commercial use (or, if you are a card seller or dealer, for your
            internal business use in evaluating and managing your own inventory). All rights
            not expressly granted to you are reserved by HobbyIQ and its licensors.
          </p>
          <p>
            This license does not permit, and you agree that you will not, directly or
            indirectly:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              Scrape, crawl, harvest, spider, or use any automated means (including bots,
              scripts, or headless browsers) to access, extract, or collect data from the
              Service, or circumvent any rate limits, access controls, or technical
              protection measures;
            </li>
            <li>
              Copy, reproduce, redistribute, republish, resell, sublicense, syndicate, or
              otherwise commercially exploit any portion of the Service or its data,
              including Estimates, comp datasets, checklists, taxonomies, or analytics,
              whether in raw or derived form;
            </li>
            <li>
              Use the Service or its data to build, train, improve, or populate any
              competing product, database, pricing model, machine-learning model, or
              dataset;
            </li>
            <li>
              Reverse engineer, decompile, disassemble, or attempt to derive the source
              code, underlying algorithms, models, or data structures of the Service, except
              to the extent such restriction is prohibited by applicable law;
            </li>
            <li>
              Remove, obscure, or alter any proprietary notices, provenance stamps,
              attributions, or branding within the Service or its outputs;
            </li>
            <li>
              Interfere with or disrupt the integrity, security, or performance of the
              Service, probe or test the vulnerability of any system or network, or
              introduce any virus, malware, or harmful code;
            </li>
            <li>
              Impersonate any person or entity, misrepresent your affiliation, or use the
              Service to engage in fraud, market manipulation, shill bidding, price-fixing,
              or any deceptive or unlawful practice;
            </li>
            <li>
              Use the Service in violation of any applicable law, regulation, or third-party
              right, including intellectual property, privacy, and publicity rights; or
            </li>
            <li>
              Access the Service if you are a direct competitor of HobbyIQ, except with our
              prior written consent.
            </li>
          </ul>
          <p>
            We may investigate suspected violations of this Section and may throttle,
            suspend, or terminate access, remove content, and pursue legal remedies. Usage
            limits (including query volumes, portfolio sizes, and API calls, if any) may
            apply to your plan tier and may be enforced technically.
          </p>
        </Section>

        <Section title="7. User Content">
          <p>
            &quot;User Content&quot; means any data, text, images, photographs, card
            details, inventory records, purchase prices, notes, feedback, or other materials
            that you upload, submit, store, or otherwise provide to the Service. As between
            you and HobbyIQ, you retain ownership of your User Content.
          </p>
          <p>
            You grant HobbyIQ a worldwide, non-exclusive, royalty-free, sublicensable, and
            transferable license to host, store, reproduce, process, adapt, modify, analyze,
            transmit, display, and otherwise use your User Content: (a) to operate, provide,
            maintain, secure, and improve the Service; (b) to generate aggregated,
            anonymized, or de-identified data and statistics (such as market-level
            analytics) that do not identify you, which HobbyIQ may use and disclose for any
            lawful purpose; and (c) as otherwise described in our Privacy Policy. This
            license survives termination of your account solely with respect to aggregated
            or de-identified data and to copies retained in routine backups for a limited
            period.
          </p>
          <p>
            You represent and warrant that you own or have all rights necessary to submit
            your User Content and that your User Content does not infringe or violate the
            rights of any third party or any applicable law. We do not endorse and are not
            responsible for User Content. We may (but have no obligation to) review, screen,
            or remove User Content at any time for any reason, including content we
            reasonably believe violates these Terms.
          </p>
          <p>
            If you provide suggestions, ideas, or feedback about the Service
            (&quot;Feedback&quot;), you grant HobbyIQ a perpetual, irrevocable, worldwide,
            royalty-free license to use that Feedback for any purpose without compensation
            or attribution.
          </p>
        </Section>

        <Section title="8. Subscriptions, Billing, and Refunds">
          <Clause label="Free and Paid Tiers.">
            The Service may offer a free tier with limited functionality and one or more
            paid subscription plans (&quot;Subscriptions&quot;) that unlock additional
            features, higher usage limits, or premium data. Current plans, pricing, and
            features are described within the app or on our website and may change as
            described below.
          </Clause>
          <Clause label="Purchases Through Apple.">
            If you purchase a Subscription through the iOS app, the purchase is processed by
            Apple Inc. (&quot;Apple&quot;) as an in-app purchase, is governed by Apple&apos;s
            Media Services Terms and Conditions in addition to these Terms, and is billed to
            your Apple account. Apple Subscriptions automatically renew at the end of each
            billing period at the then-current price unless you cancel at least 24 hours
            before the end of the current period. You can manage and cancel Apple
            Subscriptions at any time in your device Settings under your Apple account
            subscriptions; deleting the app does not cancel a Subscription. Refunds for
            purchases made through Apple are handled exclusively by Apple under Apple&apos;s
            policies, and HobbyIQ cannot issue refunds for Apple transactions; to request a
            refund, visit reportaproblem.apple.com.
          </Clause>
          <Clause label="Purchases Through Our Website (Stripe).">
            If you purchase a Subscription through our website, payment is processed by our
            third-party payment processor, Stripe, Inc. (&quot;Stripe&quot;). By providing a
            payment method, you authorize us (through Stripe) to charge that payment method
            for the initial subscription fee and all recurring renewal fees, applicable
            taxes, and any other charges you incur, on a recurring basis until you cancel.
            You represent that you are authorized to use the payment method provided. Web
            Subscriptions automatically renew at the end of each billing period at the
            then-current price unless you cancel before the renewal date through your
            account settings on our website or by contacting us as described in Section 25.
            Your use of Stripe is subject to Stripe&apos;s own terms of service and privacy
            policy, and HobbyIQ is not responsible for Stripe&apos;s acts or omissions. We
            do not store your full payment card details; those are handled by Stripe.
          </Clause>
          <Clause label="Failed Payments.">
            If a renewal charge fails, we may retry the charge and/or suspend or downgrade
            your access to paid features until payment is received. You remain responsible
            for any uncollected amounts.
          </Clause>
          <Clause label="Free Trials and Promotions.">
            We may offer free trials, introductory pricing, or promotional offers. Unless
            otherwise stated, a free trial converts automatically to a paid Subscription at
            the end of the trial period, and you will be charged unless you cancel before
            the trial ends. Eligibility for trials and promotions may be limited to new
            users and may not be combined; we reserve the right to determine eligibility and
            to revoke offers obtained through abuse.
          </Clause>
          <Clause label="Price and Plan Changes.">
            We may change Subscription prices or modify plan features from time to time. For
            website Subscriptions, price changes take effect no earlier than your next
            renewal, and we will provide advance notice (for example, by email or in-app
            notice) as required by applicable law; your continued renewal after the
            effective date constitutes acceptance of the new price. For Apple Subscriptions,
            price changes are administered through Apple, which may require your affirmative
            consent. If you do not agree to a price change, your sole remedy is to cancel
            before it takes effect.
          </Clause>
          <Clause label="Refunds.">
            Except where required by applicable law or expressly stated otherwise in these
            Terms, all payments are non-refundable and there are no refunds or credits for
            partial subscription periods, unused features, downgrades, or periods during
            which your account was suspended for violation of these Terms. For website
            (Stripe) purchases, if you believe you were charged in error, contact us within
            30 days of the charge and we will review the request in good faith. Nothing in
            this Section limits any non-waivable statutory refund rights you may have in
            your jurisdiction.
          </Clause>
          <Clause label="Taxes.">
            Quoted prices may exclude taxes. You are responsible for all applicable sales,
            use, value-added, and similar taxes, other than taxes on our net income. Where we
            are required to collect taxes, they will be added to your charge.
          </Clause>
          <Clause label="Cancellation Effect.">
            When you cancel, your Subscription remains active through the end of the period
            already paid, after which your account reverts to the free tier (if available) or
            is deactivated. We do not provide prorated refunds for cancellation mid-period
            except where required by law.
          </Clause>
        </Section>

        <Section title="9. Third-Party Data, Services, and Marketplaces">
          <p>
            The Service aggregates, licenses, and displays data from third-party sources,
            including marketplace sales records, auction results, checklists, statistics
            providers, and other data vendors (collectively, &quot;Third-Party Data&quot;).
            Third-Party Data is provided &quot;as is&quot; from its sources; HobbyIQ does not
            control and cannot guarantee its accuracy, completeness, timeliness, or
            availability. Coverage varies by sport, era, product, and marketplace, and
            datasets may be added, changed, or removed at any time, including due to changes
            in our vendor relationships or the policies of upstream sources. A change in data
            coverage does not entitle you to a refund except as required by law.
          </p>
          <p>
            The Service may contain links, buttons, or integrations that direct you to
            third-party websites, marketplaces, auction houses, grading companies, or other
            services (collectively, &quot;Third-Party Services&quot;), including listings on
            eBay and similar platforms. Third-Party Services are governed solely by their own
            terms and privacy policies. HobbyIQ does not endorse, is not a party to, and has
            no responsibility for any transaction you enter into with any Third-Party
            Service, including purchases, sales, consignments, shipping, authentication, or
            grading. Any disputes arising from such transactions are solely between you and
            the applicable third party.
          </p>
          <Clause label="Affiliate Disclosure.">
            HobbyIQ may participate in affiliate and partner programs, including the eBay
            Partner Network. If you click certain links in the Service and subsequently make
            a purchase on a third-party marketplace, HobbyIQ may earn a commission at no
            additional cost to you. Affiliate relationships do not influence Estimates, which
            are generated independently of any affiliate arrangement.
          </Clause>
          <Clause label="Trademarks and Trade Names.">
            Card manufacturers, leagues, teams, players, grading companies, and marketplaces
            referenced in the Service (such as Topps, Bowman, Panini, PSA, BGS, SGC, CGC,
            eBay, MLB, NFL, NBA, and NHL) are the trademarks of their respective owners.
            HobbyIQ is not affiliated with, endorsed by, or sponsored by any of these
            entities unless expressly stated. References are used solely for identification
            and informational purposes.
          </Clause>
        </Section>

        <Section title="10. Intellectual Property">
          <p>
            The Service — including all software, source code, algorithms, models,
            databases, data compilations, taxonomies, match keys, checklists, Estimates,
            designs, text, graphics, logos, user interfaces, and the selection, arrangement,
            and presentation thereof — is owned by {LEGAL_ENTITY} or its licensors and is
            protected by United States and international copyright, trademark, trade secret,
            database, and other intellectual property laws. The compilation and curation of
            comp data, canonical card registries, parallel taxonomies, and derived analytics
            constitute proprietary works and trade secrets of HobbyIQ, regardless of whether
            underlying individual facts are publicly available.
          </p>
          <p>
            &quot;HobbyIQ,&quot; &quot;CompIQ,&quot; &quot;InventoryIQ,&quot; &quot;DailyIQ,&quot;
            and associated logos and product names are trademarks or trade names of{" "}
            {LEGAL_ENTITY}. You may not use them without our prior written permission, except
            to accurately refer to the Service as permitted by law.
          </p>
        </Section>

        <Section title="11. Privacy">
          <p>
            Our collection, use, and disclosure of personal information in connection with
            the Service are described in our Privacy Policy, available within the app and on
            our website. By using the Service, you acknowledge the Privacy Policy. To the
            extent of any conflict between these Terms and the Privacy Policy regarding
            personal information, the Privacy Policy controls.
          </p>
        </Section>

        <Section title="12. Copyright Complaints (DMCA)">
          <p>
            HobbyIQ respects intellectual property rights and expects users to do the same.
            If you believe that content available through the Service infringes your
            copyright, you may send a notification pursuant to the Digital Millennium
            Copyright Act (&quot;DMCA&quot;), 17 U.S.C. § 512, to our designated agent at the
            contact address in Section 25, including: (a) a physical or electronic signature
            of the copyright owner or authorized agent; (b) identification of the copyrighted
            work claimed to be infringed; (c) identification of the material claimed to be
            infringing and information reasonably sufficient to locate it; (d) your contact
            information; (e) a statement that you have a good-faith belief that the use is
            not authorized by the copyright owner, its agent, or the law; and (f) a
            statement, under penalty of perjury, that the information in the notification is
            accurate and that you are authorized to act on behalf of the copyright owner.
          </p>
          <p>
            We may remove or disable access to allegedly infringing material, may notify the
            user who posted it, and will terminate the accounts of repeat infringers in
            appropriate circumstances. If you believe material you posted was removed by
            mistake or misidentification, you may submit a counter-notification meeting the
            requirements of the DMCA.
          </p>
        </Section>

        <Section title="13. Beta Features and Early Access">
          <p>
            From time to time we may offer beta, preview, early-access, or experimental
            features, including through TestFlight or similar programs (&quot;Beta
            Features&quot;). Beta Features are provided for evaluation purposes, may be
            modified or discontinued at any time, may contain bugs or inaccuracies, and are
            provided &quot;AS IS&quot; without warranties of any kind, notwithstanding
            anything else in these Terms. We may impose additional terms or confidentiality
            obligations on Beta Features. Your use of Beta Features is at your sole risk.
          </p>
        </Section>

        <Section title="14. Modifications to the Service and to These Terms">
          <p>
            We may update these Terms from time to time. If we make material changes, we will
            provide notice by reasonable means, such as by posting the updated Terms in the
            app or on our website, updating the &quot;Last Updated&quot; date, and/or sending
            you a notification or email. Changes become effective on the date stated in the
            notice or, if none, upon posting. Your continued use of the Service after the
            effective date constitutes acceptance of the updated Terms. If you do not agree
            to the updated Terms, you must stop using the Service and, if applicable, cancel
            your Subscription before the changes take effect. Material changes to the
            arbitration provisions in Section 20 will not apply to disputes that arose before
            the change unless you affirmatively accept the updated Terms.
          </p>
        </Section>

        <Section title="15. Suspension and Termination">
          <p>
            You may stop using the Service and may delete your account at any time through
            the app or by contacting us. Termination of your account does not automatically
            cancel a paid Subscription; you must cancel the Subscription separately as
            described in Section 8.
          </p>
          <p>
            We may suspend, restrict, or terminate your access to all or part of the Service
            at any time, with or without notice, if we reasonably believe that: (a) you have
            violated these Terms or applicable law; (b) your use poses a security risk or
            could harm the Service, other users, or third parties; (c) we are required to do
            so by law or by a data provider or platform partner; or (d) providing the Service
            to you is no longer commercially viable. We may also terminate accounts that have
            been inactive for an extended period, with reasonable prior notice where
            required.
          </p>
          <p>
            Upon termination, your license to use the Service ends immediately. Sections of
            these Terms that by their nature should survive termination will survive,
            including Sections 4, 6 (restrictions), 7, 8 (amounts owed), 9, 10, and 16
            through 24.
          </p>
        </Section>

        <Section title="16. Disclaimer of Warranties">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE, ALL CONTENT, ALL
            ESTIMATES, AND ALL THIRD-PARTY DATA ARE PROVIDED &quot;AS IS&quot; AND &quot;AS
            AVAILABLE,&quot; WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND. HOBBYIQ AND
            ITS LICENSORS, SUPPLIERS, AND DATA PROVIDERS EXPRESSLY DISCLAIM ALL WARRANTIES,
            WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING ANY WARRANTIES OF
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT,
            ACCURACY, COMPLETENESS, QUIET ENJOYMENT, AND ANY WARRANTIES ARISING OUT OF COURSE
            OF DEALING OR USAGE OF TRADE.
          </p>
          <p>
            WITHOUT LIMITING THE FOREGOING, HOBBYIQ DOES NOT WARRANT THAT: (A) THE SERVICE
            WILL BE UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE; (B) ANY ESTIMATE,
            VALUATION, PRICE RANGE, SIGNAL, OR OTHER OUTPUT WILL BE ACCURATE, COMPLETE,
            CURRENT, OR RELIABLE, OR THAT ANY CARD WILL SELL AT OR NEAR ANY ESTIMATE; (C)
            DEFECTS WILL BE CORRECTED; OR (D) THE SERVICE IS FREE OF VIRUSES OR OTHER HARMFUL
            COMPONENTS. YOU ASSUME ALL RISK FOR ANY DECISIONS OR TRANSACTIONS MADE IN
            RELIANCE ON THE SERVICE. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF CERTAIN
            WARRANTIES, SO SOME OF THE ABOVE EXCLUSIONS MAY NOT APPLY TO YOU.
          </p>
        </Section>

        <Section title="17. Limitation of Liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL HOBBYIQ OR
            ITS MEMBERS, MANAGERS, OFFICERS, EMPLOYEES, CONTRACTORS, AGENTS, LICENSORS,
            SUPPLIERS, OR DATA PROVIDERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
            CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS,
            REVENUE, SAVINGS, GOODWILL, DATA, OR OPPORTUNITY, OR FOR ANY TRADING, PURCHASING,
            SELLING, GRADING, OR INVESTMENT LOSSES, ARISING OUT OF OR RELATED TO THESE TERMS
            OR THE SERVICE, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE),
            STRICT LIABILITY, OR ANY OTHER LEGAL THEORY, EVEN IF HOBBYIQ HAS BEEN ADVISED OF
            THE POSSIBILITY OF SUCH DAMAGES, AND EVEN IF A LIMITED REMEDY FAILS OF ITS
            ESSENTIAL PURPOSE.
          </p>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL AGGREGATE LIABILITY
            OF HOBBYIQ AND THE PARTIES LISTED ABOVE FOR ALL CLAIMS ARISING OUT OF OR RELATED
            TO THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF: (A) THE AMOUNTS YOU
            PAID TO HOBBYIQ FOR THE SERVICE IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING
            THE EVENT GIVING RISE TO THE CLAIM; OR (B) ONE HUNDRED U.S. DOLLARS (US $100).
          </p>
          <p>
            SOME JURISDICTIONS DO NOT ALLOW THE LIMITATION OR EXCLUSION OF CERTAIN DAMAGES,
            SO SOME OF THE ABOVE LIMITATIONS MAY NOT APPLY TO YOU. NOTHING IN THESE TERMS
            LIMITS LIABILITY THAT CANNOT BE LIMITED UNDER APPLICABLE LAW, INCLUDING LIABILITY
            FOR FRAUD OR FOR GROSS NEGLIGENCE OR WILLFUL MISCONDUCT WHERE SUCH LIMITATION IS
            PROHIBITED. THE LIMITATIONS IN THIS SECTION ARE A FUNDAMENTAL BASIS OF THE
            BARGAIN BETWEEN YOU AND HOBBYIQ AND REFLECT A REASONABLE ALLOCATION OF RISK GIVEN
            THAT THE SERVICE PROVIDES INFORMATIONAL ESTIMATES ONLY.
          </p>
        </Section>

        <Section title="18. Indemnification">
          <p>
            To the maximum extent permitted by applicable law, you agree to defend,
            indemnify, and hold harmless HobbyIQ and its members, managers, officers,
            employees, contractors, agents, licensors, and suppliers from and against any
            claims, actions, demands, damages, losses, liabilities, costs, and expenses
            (including reasonable attorneys&apos; fees) arising out of or related to: (a)
            your use or misuse of the Service; (b) your User Content; (c) your violation of
            these Terms or of any applicable law; (d) your violation of any third-party
            right, including intellectual property, privacy, or publicity rights; or (e) any
            transaction or dispute between you and any third party, including any
            marketplace, buyer, seller, or grading company. We reserve the right, at your
            expense, to assume the exclusive defense and control of any matter subject to
            indemnification by you, in which case you agree to cooperate with our defense.
            This Section does not require you to indemnify HobbyIQ for claims arising solely
            from HobbyIQ&apos;s own gross negligence or willful misconduct.
          </p>
        </Section>

        <Section title="19. Governing Law">
          <p>
            These Terms and any dispute arising out of or related to these Terms or the
            Service are governed by the laws of the State of Georgia and applicable United
            States federal law, without regard to conflict-of-laws principles that would
            apply the law of another jurisdiction. The United Nations Convention on Contracts
            for the International Sale of Goods does not apply. Subject to Section 20, any
            judicial proceeding permitted under these Terms will be brought exclusively in
            the state or federal courts located in Fulton County, Georgia, and you and
            HobbyIQ each consent to the personal jurisdiction and venue of those courts.
          </p>
        </Section>

        <Section title="20. Dispute Resolution; Binding Arbitration; Class Action Waiver">
          <p className="font-semibold text-white">
            PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR LEGAL RIGHTS, INCLUDING YOUR
            RIGHT TO FILE A LAWSUIT IN COURT AND TO HAVE A JURY TRIAL.
          </p>
          <Clause label="Informal Resolution First.">
            Before filing a claim, you and HobbyIQ each agree to try to resolve the dispute
            informally. You may notify us of a dispute using the contact information in
            Section 25, including your name, account email, a description of the dispute, and
            the relief sought; we will do the same using the email address associated with
            your account. The parties will negotiate in good faith for at least 60 days from
            receipt of notice before initiating arbitration or litigation.
          </Clause>
          <Clause label="Agreement to Arbitrate.">
            Except as provided below, you and HobbyIQ agree that any dispute, claim, or
            controversy arising out of or relating to these Terms, the Service, or the
            relationship between the parties, whether based in contract, tort, statute,
            fraud, or any other legal theory, will be resolved by final and binding
            arbitration on an individual basis, administered by the American Arbitration
            Association (&quot;AAA&quot;) under its Consumer Arbitration Rules then in effect,
            as modified by this Section. The Federal Arbitration Act governs the
            interpretation and enforcement of this arbitration agreement. Judgment on the
            arbitration award may be entered in any court of competent jurisdiction.
          </Clause>
          <Clause label="Exceptions.">
            Either party may: (a) bring an individual claim in small claims court if it
            qualifies; (b) seek injunctive or other equitable relief in a court of competent
            jurisdiction to prevent actual or threatened infringement, misappropriation, or
            violation of intellectual property rights or unauthorized access to the Service
            (including scraping); and (c) exercise any right to opt out described below.
          </Clause>
          <Clause label="Arbitration Procedure.">
            The arbitration will be conducted by a single neutral arbitrator. Unless the
            parties agree otherwise, any in-person hearing will take place in the county
            where you reside or another mutually agreed location, and either party may elect
            to proceed by telephone, video, or written submissions where the rules permit.
            Payment of filing, administration, and arbitrator fees will be governed by the
            AAA rules; if your claim is for less than US $10,000 and is not frivolous,
            HobbyIQ will pay the portion of the arbitration fees that exceeds the amount you
            would pay to file the claim in court. The arbitrator may award the same
            individual relief a court could award, including attorneys&apos; fees where
            authorized by law, but may award relief only in favor of the individual party
            seeking relief and only to the extent necessary to resolve that party&apos;s
            individual claim.
          </Clause>
          <Clause label="Class Action and Jury Trial Waiver.">
            YOU AND HOBBYIQ EACH WAIVE THE RIGHT TO A TRIAL BY JURY AND THE RIGHT TO
            PARTICIPATE IN ANY CLASS, COLLECTIVE, CONSOLIDATED, OR REPRESENTATIVE ACTION OR
            ARBITRATION. Claims may be brought only in an individual capacity, and the
            arbitrator may not consolidate more than one person&apos;s claims. If this class
            action waiver is found unenforceable as to a particular claim or request for
            relief, then that claim or request (and only that claim or request) must be
            severed and brought in court, with the remainder proceeding in arbitration.
          </Clause>
          <Clause label="Opt-Out.">
            You may opt out of this arbitration agreement (except for the jury trial waiver,
            to the extent enforceable) by sending written notice to the contact address in
            Section 25 within 30 days after you first accept these Terms, stating your name,
            account email, and your intent to opt out of arbitration. Opting out will not
            affect any other provision of these Terms.
          </Clause>
          <Clause label="Statute of Limitations.">
            To the extent permitted by law, any claim arising out of or related to these
            Terms or the Service must be filed within one (1) year after the claim accrued,
            or it is permanently barred.
          </Clause>
        </Section>

        <Section title="21. Apple App Store Terms">
          <p>
            The following additional terms apply when you use the HobbyIQ app downloaded from
            the Apple App Store: (a) these Terms are between you and HobbyIQ only, not with
            Apple, and HobbyIQ, not Apple, is solely responsible for the app and its content;
            (b) your license to the app is limited to a non-transferable license to use the
            app on Apple-branded devices that you own or control, as permitted by the Usage
            Rules in Apple&apos;s Media Services Terms and Conditions, except that the app may
            be accessed and used by other accounts associated with you via Family Sharing or
            volume purchasing; (c) Apple has no obligation to furnish any maintenance or
            support services for the app; (d) in the event of any failure of the app to
            conform to an applicable warranty, you may notify Apple, and Apple will refund the
            purchase price of the app to you (if any); to the maximum extent permitted by law,
            Apple has no other warranty obligation with respect to the app, and any other
            claims, losses, liabilities, damages, costs, or expenses attributable to a failure
            to conform to a warranty are HobbyIQ&apos;s responsibility to the extent provided
            in these Terms; (e) Apple is not responsible for addressing any claims by you or a
            third party relating to the app or your possession or use of it, including product
            liability claims, claims that the app fails to conform to legal or regulatory
            requirements, and claims under consumer protection or similar legislation; (f) in
            the event of a third-party claim that the app or your possession and use of it
            infringes that third party&apos;s intellectual property rights, HobbyIQ, not
            Apple, is responsible for the investigation, defense, settlement, and discharge of
            that claim to the extent required by these Terms; (g) you represent and warrant
            that you are not located in a country subject to a U.S. Government embargo or
            designated as a &quot;terrorist supporting&quot; country, and that you are not
            listed on any U.S. Government list of prohibited or restricted parties; (h) you
            must comply with applicable third-party terms of agreement (for example, your
            wireless data service agreement) when using the app; and (i) Apple and its
            subsidiaries are third-party beneficiaries of these Terms with respect to the app,
            and upon your acceptance of these Terms, Apple will have the right (and will be
            deemed to have accepted the right) to enforce these Terms against you as a
            third-party beneficiary.
          </p>
        </Section>

        <Section title="22. Export Controls and Sanctions Compliance">
          <p>
            You may not use, export, re-export, or transfer the Service except as authorized
            by United States law and the laws of the jurisdiction in which you obtained the
            Service. You represent that you are not (a) located in, or a resident of, any
            country or region subject to comprehensive U.S. sanctions, or (b) identified on
            any U.S. government list of prohibited or restricted parties.
          </p>
        </Section>

        <Section title="23. Electronic Communications and Notices">
          <p>
            By using the Service, you consent to receive communications from us
            electronically, including by email, in-app notification, push notification (which
            you can disable in your device settings), or posting within the Service, and you
            agree that all agreements, notices, disclosures, and other communications we
            provide electronically satisfy any legal requirement that such communications be
            in writing. Notices to HobbyIQ must be sent to the contact address in Section 25
            and are effective upon receipt.
          </p>
        </Section>

        <Section title="24. General Provisions">
          <Clause label="Entire Agreement.">
            These Terms, together with the Privacy Policy and any additional terms we present
            for specific features (which control over these Terms as to those features),
            constitute the entire agreement between you and HobbyIQ regarding the Service and
            supersede all prior or contemporaneous agreements, communications, and
            understandings regarding the Service.
          </Clause>
          <Clause label="Severability.">
            If any provision of these Terms is held invalid or unenforceable, that provision
            will be enforced to the maximum extent permissible and the remaining provisions
            will remain in full force and effect, except as provided in Section 20 with
            respect to the class action waiver.
          </Clause>
          <Clause label="Waiver.">
            Our failure to enforce any right or provision of these Terms is not a waiver of
            that right or provision. Any waiver must be in writing and signed by an authorized
            representative of HobbyIQ.
          </Clause>
          <Clause label="Assignment.">
            You may not assign or transfer these Terms or any rights or obligations under them
            without our prior written consent, and any attempted assignment in violation of
            this provision is void. HobbyIQ may assign these Terms without restriction,
            including in connection with a merger, acquisition, reorganization, or sale of
            assets.
          </Clause>
          <Clause label="Force Majeure.">
            HobbyIQ will not be liable for any delay or failure to perform resulting from
            causes beyond its reasonable control, including acts of God, natural disasters,
            pandemic, labor disputes, internet or hosting failures, third-party data provider
            outages, governmental actions, or acts of war or terrorism.
          </Clause>
          <Clause label="No Third-Party Beneficiaries.">
            Except as expressly provided in Section 21 with respect to Apple, these Terms do
            not confer any rights or remedies on any third party.
          </Clause>
          <Clause label="Headings; Interpretation.">
            Section headings are for convenience only and do not affect interpretation. The
            words &quot;including&quot; and &quot;such as&quot; mean &quot;including without
            limitation.&quot;
          </Clause>
          <Clause label="Survival.">
            Provisions that by their nature should survive termination of these Terms will
            survive, as described in Section 15.
          </Clause>
        </Section>

        <Section title="25. Contact Information">
          <p>
            Questions, notices, DMCA notifications, arbitration opt-outs, and other
            communications regarding these Terms or the Service should be directed to:
          </p>
          <address className="not-italic mt-3 space-y-0.5">
            <div>{LEGAL_ENTITY}</div>
            <div>Attn: Legal</div>
            {LEGAL_ADDRESS_LINES.map((line) => (
              <div key={line}>{line}</div>
            ))}
            <div>
              Email:{" "}
              <a
                href={`mailto:${LEGAL_CONTACT_EMAIL}`}
                style={{ color: "var(--color-accent)" }}
              >
                {LEGAL_CONTACT_EMAIL}
              </a>
            </div>
          </address>
        </Section>

        <p className="pt-6 font-semibold text-white">
          BY CLICKING &quot;I AGREE,&quot; CREATING AN ACCOUNT, OR USING THE SERVICE, YOU
          ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THESE TERMS
          AND CONDITIONS.
        </p>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-bold text-white mb-3">{title}</h2>
      <div className="text-sm space-y-3">{children}</div>
    </section>
  );
}

/** A labelled sub-clause — the bolded lead-in used throughout §8, §20, §24. */
function Clause({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p>
      <strong className="text-white">{label}</strong> {children}
    </p>
  );
}

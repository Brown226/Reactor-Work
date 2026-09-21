interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      /* 标记自带白色底板，深色主题下也自成对比，无需再套深色壳。 */
      .app-icon {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .app-logo {
        width: 48px;
        height: auto;
        display: block;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <img
              class="app-logo"
              src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAkaUlEQVR42u19eZRdVZ3ut4cz3HPOHarqJqkKSYokJBYqQ2CpaBjbJ0gTUVv6PXzPtUJ3v17d7WqXojbY+NTns20BG0eedi+Niua1ODKmQQQEQyCoUElQwIQKJMSqDLemO56zzzl7vz/OcM+tIQlSSWitvVatVKVu3XvO99v7+32/Ye8DzI/5MT/mx/yYH/NjfsyP+TE//tgGecVfIKFQAKAkAMCwbJo/7fJz6YLV11ZzxdeUSePX7p6nP1t76s7NXrMRvYhQEAAq/pt5A8wN8Dx/2uUXiPKpnxWWs+bVF52KUwMfz3ANzw6OAMCgPfTkNXLPlodGhwaD/yyGIK9I4JUCIvjRs3KNTsoDl4vyqZ8TlrP0XeedgivPHQguO/MUSgihSim5adtz8tZHnuW3DQfA6MSIPfTkB+SeLbePDg2K5DYJIa9IQ5BXMPA5Uh54tyifepOwnNK7zjsFf/Ouc9xz+8p6DDxCBVBCQAmglJKPjFTEv/1oq3nbcADV8iZ6Rp77SOuJH39ndGiw2fk5ct4AswHSs3JNnvav/Ssvt/AzweIl5jtPK3cAH0oFqMhIipCOG2CUQCklB2uN4Ctbdul3/nIEQa0R2Ht/+0+tJ378pdGhwfHZDP5HZ4AZgO+h/WvfX+tZ8TFaKuGdp5XxwfUXiTV5myfAh0qCEQpGp192KNU0Q4zXGsE1W3bpd+44iMZEEyuaw18a2bThM6NDg/tn8zV/4Abo5GJCKLpXnLGY9q/9By+38APLVnbjDW99k7xx7aqgKwE+lAihwClDgvuT1Tq+smUX3Of24cpzB3DZmStACJvREAAwVq2La7bs4g/vHKOH6gJLD+7+xv7Ht3y69tSdu71mI70WnACHfXwMEN9cRtHA6Vu9kvav/ZiXW7g+Bj64ce0q2V1wdABIgNcoA4mvcvPwIfzbj7bitqcqkBMTAABaKmFgTR8+ec5KXHz6CugsMkQgVXpzWUM8OjRCP7F1iL/oalDDo3dh8+0fqT115zNes6FOhCHIcZaSxOlbfSrtX/spL7fwz5at7MZnrro4eNPKvmnAJ0ACwN2Du3DrI8+mwNNSKQLJykWf02wBABa/Zhnedv5K/K+VZXQXnI4VoQDw2BAiDIP7duyWnxqu63v21CAr9Yfx8D3XVrd+85dJLHG8DEGOF/D50y5fE9jLPidz9gUx8OLi01dQnTEegwIGAsZoAhLu27Ebn9g6hKd/9kw625ORgA8AphYZy/VDAIDTXcDlr+vDjWtXpYaIfLfqMIRSYbBp2255wyGh79w3jkLNe9Z99LG/P3T39T87XkEdOcbAs/xpl58vnP4bYFqvS4C/9IxTKKNkRuDHqnU8OjSCf/zWfXhuRKTAW0UbzcnGNPDTz84ZsHNGZDxG4Ndd2DkDl7+uD+vPWILzFi9IV4KUnYYIpQoe3V8Jbtm+z/zpQRf6RHOn++hjH2w98eP7RocG/WNpCHIsNHwctb5ZOP1fgmmtftslZ+LKcweOCPw1W3bh8Xsf7QA+O+NtLXotW96LlWcugqmA554bw+S+CejhFDlpMIhAwq+70BwTV5zVGxuinN52ENMTIwQkE0vcsn2feX8tgDZSPWDufvbDI5s2/HB0aNA9FoYgcxw8maQ88LZWfvnnzbxz0lsvei2uPHfAvezMU+LgCfBl2CEljwR81gCk2YLW34tL3r0G/7xiEQw/wC3jTXz5h9shK/V09us8dvo6T/9eNAV0S8flA91Yf8YSvGFRd+pnQqWgpgR1g7WG2DhUMe/ZX0Wr5jXzW37xoZFNG76dBnVzZAgyRxreJuWBq1r55Teaecd660WvnRY8hUp2SMmpimYqzczE9bZGkVu6EKf8yXJ8stuC7eRwQ6WOJx95AZMjkxBBdE26pXe8R7HHBjE5lBugGkRpopMX2fjYYqdDOSWGICRaFTMYQua3/OK6kU0bvjo6NFidizQHeZnAF0l54O9a+eWfMvMOnw34maTkjzY/l75PdsZbRTv9vuFLkGYLVtFGaUkPCrqPqtAwKQHrpELkeCst6IGEUTIBAN6Ei2qtBd3SUeyxYXebaDYDeC0fbhjCZAwkx9Gqe6khLjt1Ef6+XGgrpxkMMV5rBDdXqvpte8bRqAkYDzx64/7Ht9xUefy7B19OUEeOWsd3Al+m/WuvbtLCdWbewVsvem1n1DpNSircPfgcbn3k2VmBn4lynO4Cli6I6OTFQxKNVgRa4mxhtKWqCCTMLhv9/Xnomg7hC4yNeqjVBZRJYWZkLclx6CCAySDcaEUssjkuO3UR/nLpAizRtNRhh1KlhkhiiZsrVf7wSI0OVz1YLwx/Ze8t375+9BffezEbYB7tiiAvZfZ3rzhjKe1f+5EmLby3qzuHS666TN64dlWQ1fCE0pRmwlDinh1D0xTNkYZVtEHyDopFA5MxQEWTY9IN2jTDacTxIvp9rrcAIxcD5wYgJodlRT5gfLQFNwyRc4wIeAAwI4MwjaG7aKDpBWjUBCxK8CcnlfCelWWcFa+IxL1LpToM8ejQCP18U/LYED948YebPl7d+s1nk+h6zgxgWHaucM5ffLUeWutXnrFsxqgVsQMjhKQafjbgszST5fwO4Ce9dMYDgF2yUOwrRj+MN1JjLFja1UEzXsOHMmmMMUNXTw55XYPwBcYbIQQUdBCUFprQdA2+8OErAi9UMFgER/L9RSUb71lZxpl5B4REYKkphkiCus83pT7S8pHbte/ePTddd8Xo0GBjzgxQfsO7v9XKL19/641XNS8+fYWeBE8J8FHyK3qtL0Oc/cF/xdD2vVALew874xNDTAVdtbxpur7DqS4pYVlf5AOEL7BnTy2aKLbWQTPZUbI09HS1HbpLgPGmD+VLEI3CYAQaUVAahx6D2/QCuG6Id7+qjI+vWIwwA/xUQ4ShDO7ZMSSuGfWs3K59//7key/9H0eDLTuaF9GT3/yZUKKkr3mVdkFvgeUMPY4kVTzzSexkFQgI+vu6EDoWntk7BuW6IKY54/tqpo7Skh6YZgSWB0AnFH78e13jHeDrlo7u3gJ4TkPDDVCfcJGzOHJFE1RjCGN6SjiegYCZHIxT2HkNRuwH3PgtGY/oklMCrjPonLVntlIoMYZ1J3fhL5cuQJ4xkEz6myCSrYkhKKF0dW8327ZzOPy14KXJ2zd8Yc5WgLP2/dtDbpwuWp7sWViib7n4bHxp/UXT8i1T08Qz5XCysx7AtBlfLBrp309OehCMoJDPwSiZsLtNNMZcVIMAxJWpczW6TCwyo0lREz4mmpEJc3kDiwsGHFtHvSEw0mrPeIcDlpNDkVPUGyI1jFAKBRBc0JfvcMhI/UA08dqTDlnlJP/2J9voXSONPQf/6ryT59IAT4XceC1nkEIENBAhCvkc/vTtb8LfvOucNMzPpoITf5CVnj/Z20LDlx25m+R7nm/7hQT0vpUR5wd7D6BiFeE1/A6qmUozuslRKmjIZ0Cr+T7qAaB8CdNsL3iNRNeq6Ro0nYOaHPlA4uyC0QG8jOVoQrF0FsSkAgiU/Ot7X5oBjoqC9GXnvFdRvlAqKI1RYhgaXD/EjsHn8L07HsPTdQ8Llnbj5IINSgiAyCckXycXbPzZG16F/3JOP1ydYOfzo3AnGzAtEzxvgxqdgZNdtGCUTLiKoFXz4ekmGCEwdAYSpyOMnNZBMYxTWJTAAgPTKRxbh/BDKM6gpEJISEo1lFHonCGkFCGABaaG83q7cN2yHrytXEKBMYRKRfeB6N9oQkW1iI89+BvQeh2r+3oQxqshehXUXc/tJzvr/mTjzm9+Yc5XACWQlIASRMuPEgIRSrhND1xnuOK/Xogrzx3AujWrUh8hkynUmZfHNVt24c5fjqA+Vu2kny475eDWWBPU0KBMiqJjYlEpcqIHJlqpmoHJOmZ9zfdRa0W+wDQZunUOx44MXGkKCNVepYttAx9e6GD5glLHjE+uPUszm4cP4Zbt+9Jr/u+XvApfv3QNAqnAKUlXwDu2v0C3bd+/Z+9VbzqqFcBfWiQcmSxxQACgUQI9n0MQSty68QHcuvEBnHrOKnzmqouxbs0pabItDCXCODbpLjj4+qVrMLZ2Ff5pqIKHtz6LF10NNU2DPuFCxLmcXLeVfrbX8vEiFEqWlhoCAHQ7uoUxESkWolGYJospRmFMBKhCwTY0lC0dk4FEkVN8eKEzLR9EQCJlQ0l6f2nKZDhI5TDJGSj0ds2I0UpF8DQ5+gTDSzOAjAKt7PsnPE9pxNuhVHhm6y68Y+uu1BAd+ZbEEEqhu+Dgc2sciNOXprn/oZqC2WXDsDXohEAolaoaAZU62P4lkX+YDCSa9RZct1NOpvwer6bJmotil4VPLS7gjb3ldio6Bh4KoDRWNirE3dui63l2bysF/liMozWAVFJCUYCoNqVM5bJQSigpUezKA8ARDKEQxnl5nTGsW7MKl56+EvfsGMINhwR27huHC6DomGnkuogBTgzE3vEmGjWBUkFDX8lGXwmoNwRqfmQgpfGUbs6zTLxzuY039ZXbun0K8MgEkFngNcdsZ1fjDKvmmMfdAJSR2M0Qks76aS8iBCGAQAGcAFZOA6EsNUTfyWVcctVlHZWqLDUxRrFuzSqsg8Lm4Qpu2b4PP6+FsCyeBlEJx5sx9/uKYO94E5bBUbZ1OIhopuH5OM8y45SCnbq7NscDbAbgn/ntROqTzJIFNxONQ+cwGYM4ESsgVAScUSBWDrPJJ0lo+jupFKhSsO1oxoy8UMG3/vctuGthCdNiicQQsXM/b/ECnLd4AZ6s1nF3pYrv/raC0A9h53XkczTN0GhEIa9pcONVYRkcl/Tmsa68qAP4ZMarDMcn1bcs8E53YYoE5DiW46jfPXGmJFYHHZnLuNaqFJAs1oDrIMQFIfHNE8BxTChCMDlRw60bH8B/3PEo/vTtb8IH11+UJr5CqSCVip09wVkFB2cVHKwrF7BxqIJHJuuoB4DDI44HgDEvQLfOcUl/F9aVC+0kmlKQmE41Y9U6/mmogo13PZ2qsCzwSfQ9lWiooUHEEXmpqB9fA0xLF2fknEqMoKIKEZliGBqrJwkFFYSwbQuBBVRjQ2y6fQsue8faaUGdgoKMJe9ZBQdnrXGwz/fxjRcP4eGRGmrCR17TcEl/17Q0cnR5UQSVBf6aLbtwx4O7olpDzoDT1wV44ZRJT6fTq6GlQWDL8w8vVkw+9waQCmAkohWVRocKYRiCZgouBJ0KSUkJUDpjwGGaHJxzuH6IWzc+gNt/+DDeccUFU2KJqIhOSBQULdE0fHzFYuxb6uNgy8PCnDGjhidxdhaEpI1cWeBNBOA5o6OGPA3IogHa8Gc1xnFfASRNQsV9NroOU2NwWx5C30+piROA6Bxu3FtDpIxqqPHfBVwHfBFzfwjGKPR8DkIEM8cScaSpJCCB1BAJ8Fl+J3F2Nqvh/2Ovm7asmBoDggAe5+AGizg+uwISzhdBmvpIbWRr6OrJYSLHj7sB9MQCST5QKQXhughDDWbOQFgoQNTq8LvKMN94OoLhMbAdOxAKEdNTCBpLUE3nUIFACEARGklDqcA5BWMGKOfTJOy6NaekwIYSUHF+hsTXROJYJAv8j4caKeimxuBxDi+uqPEpHRRTHW6ut4Azz+iN5PTO0Sh9bnE0mwHcSuvwaJlsbg2QM0JWD6dLTsUoQt9HQwgwM4Sed9B7xXlYf+Eq7Ki38LONNpqbt4CEAKRMS0u+CNIPpjNQncEonIKFIAhnjSVUJgdDSWfZ87anKhEORQc8byOoNeBx3i5lJjjFP7sIUvATejnnvOW4thw5808CeHrHAYy34hjDpEeU7XNqgJbHWjO9koJAUQYoCeW58DUdS0/K41KT4VLTQeXNK/Hor38LduB37RbROFAKuA6g1cHZJI4fAq5DhS4oADufAzLRdd/JZXz1I/8N69asQhhKUEaxefgQPnDHE8lOGRhFBwwK2TkzFXzBSFvlxPoeAFzPR+mkIk53cigWorwUy02gGgRpSdOdOhtncJlHawD6+76OxIWYxNFRxhB6Lvb+ah/ucaMLDA0OWiqB5aO0gRIe/LiLGb5IG6OyqmpaMVsqqDiWcAoWRl6o4O+u/x5EGIJQCqWQgm8UnbTeECZu34ioJwv81AobALhhdM2lk4ppLRkAbj1Yxe5dlY6i/rT82HGToWkwTDpzQVJCAWBKYt+WHfhWl43bV5aw54Hd4Ht2Q7MtaD098EUATE4AvkAoI6CljFRUAn4qb2UQ/Uxo1JQBBRmG0HMGRDNAvdFCd8GBCENUhZb2D4UZvcWgIpqJnWwCfFZmkqIBc9KDUTLT3qGRuot7t+3DjlN68PzeCsZHW+3ag8mQg3H4pgJ6DJJxUS5oZjnJYk5WSoGNV3Dw+z/FPssBG69A+gG8ZhOcEtgFB9qCMnJaiOqEB1eE4LFmTsAPpEoj6Yjn210ZhABB3FiVHQXdx3DOAKb8Lqm6zQS8CCSKSZWNENTqAqhHysy0NezcN44DrgDcMAVfN/mJi4TJLOB3BmcRV2k6hxa4aPoBKGmrk+Z41NOfO6mMQsmAqTM06i0o34NiHKAMkAFMEsIlFITIjs0TkPKw/TYe5zCCoKO6NlNwZeYMFOMZ3xhzMTnaADW0jqK+yRgWmToOQEB3w1TZWJSckFxQR5SVOM0k0iWZIIiEIXwRRGU+FYKCRMDGRvSCENWGSuMAs6sUd7RNwPcDGMUS6n1LwIf3QXkuSExFhysfVYUGoBU72jY9mCUL/QMLsH9/DZMjkzBzRtpBV6sLGEpBJwSkaKQFe50QEJNDZPeOZXqI0szh4WCytWOXilCZYoxumXBbHgLfj5wyjaiIxFIzjYaneCxN5/B9gcZEDbzZBDdNmKUSAm5i0XsuxJrX9mHwV/vw4g83A+MVUBm85Jllliy8cd0Ari07uMcN8YNfPI/GmAsvLvhIz4fu6FHaoB50gB8FPqQNelJ490OAEljdOTDHnvWzk3rEXKqgqCaqOnNBgR9CKxRgFxwQRhGGAUSGhwOpkGwUSvw2pyQyjqaD6wycEgSuC+/gAZDFfVh/zgr884pFWH/hKuTPfjUQBGltebZR0KenC/oHFuDasoNiwcalJkNe1zA52kirbdTQUrBNxjrATwWYw0E0GgEPYEHZQv+SIgxGENYbc0JB9KXkggACFVMPAPi+gJicQOCH0IslmD09MDQtpRdCKOQsopgHbSbVNA7CNajhEeyoR7HBpSaDtbwbZlcJhHGoMIwjX3pUs797YbuCdY8bYv/+WkdCLQ2mYnrpAN9k6f8bjGBB2cLiQkRtIxMNuG44Z3KUv9QMKAGJ1JCUaROqEAJwXVDDhFYqtp2ikiC+D8U4FM+0hOg8br5qApRFLX+UQp8cw882Ponr3nMWAODQ4D5wEUDPO/CFCdmsw/d8BP50ADTHRNHRgS4b3oSLbdv3Y6Mi6DkpxJ2/3B1x/hQnmzrVGXI7FiVRDVnn8EWAkTgKdjjSzowTm46OawNQSAFUQqDRcqEXCtB0DmdBGarZhNdqQYgAmsYPF15ASQlvy2O4a6wK0myB79kN0XKjHHzOhFEqgWpNcK0zKOLLFqHgT8ID4I5MRmmFsSb+/bG9KJQrqFaaHeCnIFsZvjcZ4HZW3wBgsuZ29I2qOJl3OB8w56mI2cqPMlOcUQAUJeCxYvFFAFGtQi8UYPZY8EUAv16HcAPMVFElSoHIEEEQwNr7PPxGE6LlgtDoXrxmE6HbAnQDutUZCAV7D6BaU9AtPc3vJFxvWRzeFPCT3k+DKHgqKvaXKEHPSfm0w6JRE1ia5upI6lw1QnA49i8VdWDy6JXqS1dBSgKgUdVqqkLNEKGmcwgAolqFTyk0x0HPojyqDSdNRbQdTBTxKqUAGXZ8Fo9aLkAJB1ESrWoDTdY5wap2CbrbiOq1Gb1vzAB8wvUCEfh5XUNe16DbPAWeaSxVP1xnCEQIrrNUzRns8IQv6sHIMV8Bh9tH0PEBnEKFIbzJCYw3OJjtoFXuRbf2O4x6AkEQgFOCqb41lDJqHYlXACHRe3OdTaOg9Mb57Cuf5DiyJ0sk3dKhwTGxv4amGwHPrRlWi96OETSdgyt1/IvyR/IH2ReyTByg4iSXxqLtO41Do7ABtHQOqzsKwsTkBJTnAVxLKY3Gh3GwjOqaycDZKpVha+k2pKngJ7M+AV40AtR8H74I0JQqBT47ux1bh9sUHeAfzbC7c31z3paipAThDAqqozAfhBIkoQSlQGMfkFBQEowRFqUyuM4iFdRoojFRQ7Erj2I5DyCP5qQHUa/FBlCQ8U7EJJiL8k3T50J3jxHlcjLqJsv1yYzPx0X84aqHVs1D1wIrWlFTwNeIgq/aQWN2TVCTA56P8wNx5ALWsaYgLWcgVAxwmxAigM4ZslxCKO2gliihRhMnAdPk8FoteK0WjFwOVtEAsSzktBCTMoTyPUjdSPNMh0tGJbpez/T3E5OnHA8AB1wB4QbQTY5c3oBlRLffyIDPdQYts+qoySHddnBZ0hhKcaFmtuELf/8xScapuF2kvffWBSMEWs6AVijAbzQR9q9Aee0AWvuroPf/HAiDyMlOaWlsd3xFcYDvuph03ahsWXZQLOfRnNThtVogYQBwDThCEJaAT0yOLovD7s6B6RzDw9UO4KcOg0Vd09n3WGwbeP3ibgDAE+O1NGD0/QATfoifcx3nzYZVw28dm0CMAJTQjob5IAggqj6MXIigfwVevf6NeMeqiAK/CKD1kwdBGE1bVmYq6pAopx29n+ei2rAjlaTpMHusNJYgwgMIOwL/mumMr0x6yOfamzXa3RgMXqgiKhTBNAOWLR2vX9yNKxe2e4WeGK/hULPdJXcECjr6FM9LfR2JgZdJko1REMbguy7kxASWlh1cubCAS02G0849GdRyIIMwTiUfeWe5Yjwt2suJUXgTEwi4DrOnB1acOfWz7YLxKJZt9PbmYRCFA67AixNNhH4ITdfAtGhfQfLVwfc6j7YnZZanWcjhUpNhaShh+JGBJvwwoh+NYS7Hy4upKQWNG6cI59Anx/DE1hdx68FoE3kVCsHiJWD5IpRS8P3gsCqqI7agPKIdKSEnRiHGxiJlsqAMu6czCnVKFpjGcMAVONAI0uIJmwKWwchhNbymcyzqsfGajOg72PLS/NTRjCNEyC83FxR1t5G4HpAaQcpUsTTueAhfbvjYuLyEyoPPTitJepMT8BtNQNPbFTDSNkIYqw9Cafp/SjMAJVGdbECpGnKLO3vzRSNAq+YhlzdS+ZHMek3nIJrfoXDUlJSITggW9djQNA632sJDPgUqVdzjhthRb8H3g3TmaxpHqfMMsOMXBxAlU0eoMkaghKRzJqjVgPu34BAAt1YHUxLu6CgoZcg5uXZJsqHgugG4rkATGUvbO8yVlJluCZkGdb4vIZrTV1JSLszO+gT07J6BZBuqUApFTmEWoryPW21hrObFi4/ioaaPBWh1rNoklzXhhzihgRhRCoq0G7SkUiCQ0WkGoUwrYhAewBgYY4BSaFTrCFUDKHejYIcAeiCbdSgRc7puQFNhugJCRcAQV98IPeq5NlO2UtM1iLgCVrZ0sJyWqpqxmgdqctAZIulsAjExxoWWhuULSlESkby8tpSjbcyy62EchcZNtjRpO8xUvMgMDlbFhRwFAsIYlB9EiTkBhJ4LM97I7dbqkH4Atbgf7IwBiO3PgsdyWoUh4o8+KuCTmV/Mm1jUbaPIKSpNAdvQ0B2robGahyL3wXJaFFxlE2pTfEcC/JkaxbpyAWfYVtotnj21MXEvTsnqnusVYCophaKgJG6NUDPkQxShkCyzd4BmDsiIYuiOVELgumh4AnrOhJmPckSviWXsvduW4Vdfvw/62EFItI8JmFH/2xws7KSFZV1WKiWHhyu42Q3T2Z46zJx2WOCTkQCf3W+gMtekVFTpU0ph9HfjAoA/pypINUa/wAxdDyS4DENXhVKquK8HUoKoqJWEToGIptEviQ7xoHRa4o5QCtGKSpJG0cE7VvXhyoUFvPXMJSheeHZ0AAg5uv2cWZVzdsHAlQsLWBpKLF5cBgC8WKlHVBN/aRpPKWYm8E93cri27ODjK/riPQdxSqRjb3C0O3Kf74tPPT8if1c09b4nd357TldA7ak7b3L6Vu/xes//stKMRaECaBi6REqdsKg9Tc1Ql0u4O0uJZIoRGGTk16mG1p592FFvpXHE18o5BF0l+NUqPE+kG+sORz8aUbCczqL5ZLWBQ00P+WJu5hx+DH6i9afOeDVFCZL0VpV8stoI7q5U9W2+1AHAuu+J9/3wI+/+v3NqAK/ZUN7Q4A+MkZ23O32r3+L1nn+TytkD8AVkELqEEK4Y5UQpIAwBAx0R5iwJk5S2oCRopiT5wctPRY1TNH75fOTQCwVoAPxqFW5tdk2+rMtK9wM/MV7D+YHAMICb3cOrlgT4Cy2tc4fNVOAJ0iPNnqw2xN2VqrnNl/pYzXNHv3PvP4xs2vCt0aHB+rE5MStzaJNh2dTpW73W6z3/syRnv8H3BBhRghBCFaGc6XrUZCt8KMY6nHMYSphdpbTixTltd1vQKAALl58COTEBY/wQAiHinfFRsq7aUCjYBNu/9oG0NfHPn9qLyUCCeQHGYsNznSFfzKGksVllY0lj0DSO050c1ndZHTtsMMMZQUqFcrDWSoDHWM2rjH7n3mtGNm24dXRosPX7nCV39IFYJgbwmg3pDQ1uNkZ2vtHpW322UR643rWWvjmUAFNSKCFowCgHJTMqo7RniNLMco4bcUOBXGU/gloNMmj3jSZZU+gGYE+nkoMTrWlJNekGwAzcLt0ARU5x9sLSEYGP6hGhfGRkLPiZ6+vbfGlOVhojB79//3tHNm3YNNOxlurYNefK9sIhJKGmX5Hd29/SveKMVaQ88GlhLbsiZAwQXkApk4RRfUavr+ngQoDE5zCk4lkp+CJInFv7mIM4WdeoNiDMTvVSbwgYjKTp5Wk6PrMCSho7auBFGAaPHxgLbjvQMLdpRCeT7tMHv3//1SObNjyYPCQie8KuOn5dEZlOqag1RY0ODe4ku7f/efeKM07WywMfFU7//wwJjQxBiCSc69meoEB19tOoOBKWqi1jk+Ppsw0A2gz7sxxbRzVz+9nKle8HkG6A7ryBs7vyLwV4ebMb6oeaHvcPNXa8sOG29x26+/pH5vpo45dfE077NqM0wujQ4AsYGvzrnpVrPqaXB6717KUfCEKABYEkQEAo1f20cSvTZxorpqlt+DST7jhigSgLfExzJzcZrl5cmHYuRPJ+U4G/b8du+Q0rp0/4IRp7xh4e/vamjx66+/rHjtWZ0nNXlM8YApEh9mNo8OqelWs+bZQHPiispf8YMq4jCAAFQQl4wkgylhhEyXaXb3azdybaPtKN+yKAUApLyw6uzhsZ4FV69k+yohLgx6r14OZKVW7zpT6h6Wg8d2jT85/7xkeqW7/5m2N9qvrcN7x3GEJhdGiwgqHB6wzLvjF/2uV/K6ylnw4Z11W0ClxCqQ6A0pjSQqWgxRv4MFOaepYRiBANxOdCLLJnnfHRCblIgBc3V6r0iarHa5xicvMzG/fe8u3/U3vqzl3H67kCx24f/hRDeM3GhPf4d683LPvL+dMuv8ozT7pRarpFfAECuJIQ/agaP6edOEXSGODDC51pB3JEFTeSAg8AT1br4u5KlT/U9HUAmHzst/8an/25p+Psz/+sx9fPHkd0HPBtOn2r3+71nv95lbP7iC+glHIpITrVNJp0QGQ7sgkh8PwQhaKNZ/7fh9FdcKCUwu+CAL2MdxxBEx070+7sTp4tc3elqj841kLD8yF3vPDJvbd8++bK49+tnKhHmhz/Z8hMNwR3+lZfRvvXftGlhX4ZBCBKRtREQIlCelqhVAqeH6BYymcM0FZSCfAynfmdB3FvbroIRCiC2x/6xMimDV9pn/984p6uxI/7J2apKQrqAm9o8A5jZOcmp2/1hV7v+TdRO3+67wlQFbqUEA5CeFJ/mM5S7T0IibZMznvePFIRtx1omJubrhmIcCK4/aEPjWza8N2ZotYT9WgrjhM1pgd1gTc0eL8xsnON07d6rew9/4sqZ6+RQQDIUFBCKKGUT49I4iNoMlHr5uEx8S8H6+ZwwzP9cffF8Kdb3jeyacM96YPdfs+o9Q/LANOCutQQSZrjbKdv9eu93vNvUDn7AhkEoFIKpSTVrWjjr0wda1vDf41wfVelYfrD9WfdTfe//9Dd1z/oNRvBKw34V/CzJOPzITsfdfVqUh64qZVf/lYA0GQo7/zOh+S5fWXqSynv27EbNxwS/IArkP/dga0HH/rVtcciav3je5pqJgMbG2IlKQ98VBRX/sWygV6cccoyPMM17DMcqH3VO/DwPZ+obv3mjhP1SKo/yMfZzmKI5bR/7dW1nhXn0FLp19aOn95Ue+rO32SDpxP5dLz5MT/mx/yYH/NjfsyP+TE/5sf8ONz4/xqaxeGQ3MVeAAAAAElFTkSuQmCC"
              alt=""
              aria-hidden="true"
            />
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}

-- Correções manuais de ticker — empresas conhecidas que a busca automática
-- não conseguiu confirmar sozinha (nome curto demais) ou errou.
-- Revisado manualmente com base no conhecimento do mercado B3.

UPDATE companies SET ticker = 'BBAS3' WHERE name = 'BANCO DO BRASIL S.A.';
UPDATE companies SET ticker = 'WEGE3' WHERE name = 'WEG SA';
UPDATE companies SET ticker = 'GRND3' WHERE name = 'GRENDENE SA';
UPDATE companies SET ticker = 'FLRY3' WHERE name = 'FLEURY SA';
UPDATE companies SET ticker = 'ALPA4' WHERE name = 'ALPARGATAS SA';
UPDATE companies SET ticker = 'TUPY3' WHERE name = 'TUPY SA';
UPDATE companies SET ticker = 'POMO4' WHERE name = 'MARCOPOLO SA';
UPDATE companies SET ticker = 'SHUL4' WHERE name = 'SCHULZ SA';
UPDATE companies SET ticker = 'CGRA4' WHERE name = 'GRAZZIOTIN SA';
UPDATE companies SET ticker = 'RCSL4' WHERE name = 'RECRUSUL SA';
UPDATE companies SET ticker = 'MNPR3' WHERE name = 'MINUPAR PARTICIPACOES SA';
UPDATE companies SET ticker = 'ABCB4' WHERE name = 'BANCO ABC BRASIL S/A';
UPDATE companies SET ticker = 'BBDC4' WHERE name = 'BANCO BRADESCO S.A.';
UPDATE companies SET ticker = 'PINE4' WHERE name = 'BANCO PINE S/A';
UPDATE companies SET ticker = 'BEES3' WHERE name = 'BANESTES SA BANCO DO ESTADO DO ESPIRITO SANTO';
UPDATE companies SET ticker = 'BGIP3' WHERE name = 'BANCO DO ESTADO DE SERGIPE SA';
UPDATE companies SET ticker = 'BMEB4' WHERE name = 'BANCO MERCANTIL BRASIL SA';
UPDATE companies SET ticker = 'CSMG3' WHERE name = 'COMPANHIA DE SANEAMENTO DE MINAS GERAIS';
UPDATE companies SET ticker = 'ORVR3' WHERE name = 'ORIZON MEIO AMBIENTE S.A.';
UPDATE companies SET ticker = 'TPIS3' WHERE name = 'TPI - TRIUNFO PARTICIPACOES E INVESTIMENTOS S.A.';
UPDATE companies SET ticker = 'RENT3' WHERE name = 'LOCALIZA  FLEET S.A.';
UPDATE companies SET ticker = 'BBDC4' WHERE name = 'BRADESCO LEASING S.A. - ARRENDAMENTO MERCANTIL';
UPDATE companies SET ticker = 'PSSA3' WHERE name = 'PORTO SERVIÇO S.A';
UPDATE companies SET ticker = 'TIMS3' WHERE name = 'TIM BRASIL SERVIÇOS E PARTICIPAÇÕES S.A.';

-- Corrige empresas que caíram erradas no MESMO ticker (BBAS3) por causa
-- de um bug no script de mapeamento original (confiança baixa tratada
-- como alta) — achado ao investigar tickers duplicados.
UPDATE companies SET ticker = 'DAYC4' WHERE name = 'BCO DAYCOVAL S.A.';
UPDATE companies SET ticker = 'STBP3' WHERE name = 'SANTOS BRASIL PARTICIPAÇÕES S.A.';
-- Brasil Biofuels: não achamos ticker confirmado (provavelmente não é
-- listada na B3) — remove o mapeamento errado, volta pra "sem match".
UPDATE companies SET ticker = NULL WHERE name = 'BRASIL BIOFUELS S.A.';

-- Empresas conhecidas que ficaram "sem match" na busca automática
UPDATE companies SET ticker = 'EMBR3' WHERE name = 'EMBRAER S.A.';
UPDATE companies SET ticker = 'BRFS3' WHERE name = 'BRF S.A.';
UPDATE companies SET ticker = 'MGLU3' WHERE name = 'MAGAZINE LUIZA SA' AND ticker IS NULL;
UPDATE companies SET ticker = 'GUAR3' WHERE name = 'GUARARAPES CONFECÇÕES SA';
UPDATE companies SET ticker = 'MRFG3' WHERE name = 'MARFRIG GLOBAL FOODS SA';
UPDATE companies SET ticker = 'OIBR3' WHERE name = 'OI S.A. - EM RECUPERAÇÃO JUDICIAL';

-- Conferir o resultado final
SELECT COUNT(*) AS total, COUNT(ticker) AS com_ticker
FROM companies;

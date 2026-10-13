'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {translate,translateReport,normalizeLanguage,catalogs}=require('../src/ui/i18n');
test('all supported languages have matching catalogs and template parameters',()=>{
 for(const lang of ['es-419','pt-BR']){
  assert.deepEqual(Object.keys(catalogs[lang]),Object.keys(catalogs.en));
  for(const [key,value] of Object.entries(catalogs[lang])){
   assert.ok(value.trim());assert.deepEqual(value.match(/\{\d+\}/g),key.match(/\{\d+\}/g));
  }
 }
 assert.equal(normalizeLanguage('__proto__'),'en');assert.equal(normalizeLanguage('fr'),'en');
});
test('dynamic summaries preserve IDs, counts, and whitespace across languages',()=>{
 assert.equal(translate(' All 2 replicas were copied successfully and are active. ','pt-BR'),' Todas as 2 réplicas foram copiadas com sucesso e estão ativas. ');
 assert.equal(translate('Last check: 10 of 5000 replicas checked.','es-419'),'Última verificación: 10 de 5000 réplicas verificadas.');
 assert.equal(translate('Course unavailable or inaccessible (HTTP 403).','pt-BR'),'Curso indisponível ou inacessível (HTTP 403).');
 assert.equal(translate('Tenant course name 9532','pt-BR'),'Tenant course name 9532');
 assert.equal(translate('Review & Confirm','unknown'),'Review & Confirm');
});
test('Source Course recheck guidance and update time are translated in all supported languages',()=>{
 const timestamp='13 Oct 2026, 14:05 UTC',updated=`This app's information about Source Courses was last updated on ${timestamp}.`;
 assert.equal(translate('Recently changed Source Courses?','es-419'),'¿Cambios recientes en los cursos de origen?');
 assert.equal(translate(updated,'es-419'),`La información de esta aplicación sobre los cursos de origen se actualizó por última vez el ${timestamp}.`);
 assert.equal(translate("If you've created, archived, restored, or deleted Source Courses directly in Brightspace since then, some changes may not be reflected here yet.",'pt-BR'),'Se você criou, arquivou, restaurou ou excluiu cursos de origem diretamente no Brightspace desde então, algumas alterações talvez ainda não apareçam aqui.');
 assert.equal(translate('Check for recent changes in Brightspace','pt-BR'),'Verificar alterações recentes no Brightspace');
 assert.equal(translate('Select this to check existing Source Courses directly in Brightspace before creating new ones. This may take a little longer.','es-419'),'Selecciona esta opción para comprobar directamente en Brightspace si ya existen cursos de origen antes de crear otros. Esto puede tardar un poco más.');
 assert.equal(translate('Last update time unavailable.','pt-BR'),'Horário da última atualização indisponível.');
});
test('report translation changes headings only and preserves CSV body byte for byte',()=>{
 const csv='\uFEFF"Source ID","Replica name","Copy logs"\r\n"9532","Status","Todos os dados copiados com êxito\r\n<example>"';
 const result=translateReport(csv,'es-419');
 assert.ok(result.startsWith('\uFEFF"ID de origen","Nombre de réplica","Registros de copia"'));
 assert.equal(result.slice(result.indexOf('\r\n')),csv.slice(csv.indexOf('\r\n')));
 assert.equal(translateReport(csv,'en'),csv);
});

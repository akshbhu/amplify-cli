import { Expression, set, ref, obj, str, ifElse, compoundExpression, print, raw, qref, printBlock } from 'graphql-mapping-template';
import { ModelResourceIDs, ResourceConstants, toCamelCase, graphqlName } from 'graphql-transformer-common';
import { KeyDirectiveConfiguration } from '../graphql-key-transformer';
import { InvalidDirectiveError } from '@aws-amplify/graphql-transformer-core';

/**
 * Return a VTL object containing the compressed key information.
 * @param args The arguments of the @key directive.
 */
export function modelObjectKey(args: KeyDirectiveConfiguration, isMutation: boolean) {
  const argsPrefix = isMutation ? 'ctx.args.input' : 'ctx.args';
  if (args.fields.length > 2) {
    const rangeKeyFields = args.fields.slice(1);
    const condensedSortKey = condenseRangeKey(rangeKeyFields);
    const condensedSortKeyValue = condenseRangeKey(rangeKeyFields.map(keyField => `\${${argsPrefix}.${keyField}}`));
    return obj({
      [args.fields[0]]: ref(`util.dynamodb.toDynamoDB($${argsPrefix}.${args.fields[0]})`),
      [condensedSortKey]: ref(`util.dynamodb.toDynamoDB("${condensedSortKeyValue}")`),
    });
  } else if (args.fields.length === 2) {
    return obj({
      [args.fields[0]]: ref(`util.dynamodb.toDynamoDB($${argsPrefix}.${args.fields[0]})`),
      [args.fields[1]]: ref(`util.dynamodb.toDynamoDB($${argsPrefix}.${args.fields[1]})`),
    });
  } else if (args.fields.length === 1) {
    return obj({
      [args.fields[0]]: ref(`util.dynamodb.toDynamoDB($${argsPrefix}.${args.fields[0]})`),
    });
  }
  throw new InvalidDirectiveError('@key directives must include at least one field.');
}

export function setKeySnippet(keyDirectiveArgs: KeyDirectiveConfiguration, isMutation: boolean = false): string {
  const cmds: Expression[] = [set(ref(ResourceConstants.SNIPPETS.ModelObjectKey), modelObjectKey(keyDirectiveArgs, isMutation))];
  return printBlock(`Set the primary @key`)(compoundExpression(cmds));
}

export function condenseRangeKey(fields: string[]) {
  return fields.join(ModelResourceIDs.ModelCompositeKeySeparator());
}

export function ensureCompositeKeySnippet(keyDirectiveArgs: KeyDirectiveConfiguration): string {
  const argsPrefix = 'ctx.args.input';
  if (keyDirectiveArgs.fields.length > 2) {
    const rangeKeyFields = keyDirectiveArgs.fields.slice(1);
    const condensedSortKey = condenseRangeKey(rangeKeyFields);
    const dynamoDBFriendlySortKeyName = toCamelCase(rangeKeyFields.map(f => graphqlName(f)));
    const condensedSortKeyValue = condenseRangeKey(rangeKeyFields.map(keyField => `\${${argsPrefix}.${keyField}}`));
    return print(
      compoundExpression([
        ifElse(
          raw(`$util.isNull($${ResourceConstants.SNIPPETS.DynamoDBNameOverrideMap})`),
          set(
            ref(ResourceConstants.SNIPPETS.DynamoDBNameOverrideMap),
            obj({
              [condensedSortKey]: str(dynamoDBFriendlySortKeyName),
            }),
          ),
          qref(`$${ResourceConstants.SNIPPETS.DynamoDBNameOverrideMap}.put("${condensedSortKey}", "${dynamoDBFriendlySortKeyName}")`),
        ),
        qref(`$ctx.args.input.put("${condensedSortKey}","${condensedSortKeyValue}")`),
      ]),
    );
  }
  return '';
}

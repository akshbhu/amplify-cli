import { TransformerModelEnhancerBase, InvalidDirectiveError, MappingTemplate } from '@aws-amplify/graphql-transformer-core';
import {
  AppSyncDataSourceType,
  DataSourceInstance,
  MutationFieldType,
  QueryFieldType,
  SubscriptionFieldType,
  TranformerTransformSchemaStepContextProvider,
  TransformerContextProvider,
  TransformerModelEnhancementProvider,
  TransformerPrepareStepContextProvider,
  TransformerValidationStepContextProvider,
  TransformerResolverProvider,
} from '@aws-amplify/graphql-transformer-interfaces';
import {
  getBaseType,
  attributeTypeFromScalar,
  isNonNullType,
  makeInputValueDefinition,
  makeNonNullType,
  makeNamedType,
  toCamelCase,
  ModelResourceIDs,
  toUpper,
  makeConnectionField,
  wrapNonNull,
  withNamedNodeNamed,
} from 'graphql-transformer-common';
import { Aspects } from '@aws-cdk/core';
import { DynamoDBTable, TableKeyType, AttributeDefinition, KeySchema, TableIndexProps, IndexType } from './dynamoDbTable/dynamoDbTable';
import {
  DirectiveNode,
  ObjectTypeDefinitionNode,
  InputValueDefinitionNode,
  Kind,
  TypeNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
} from 'graphql';
import { DirectiveWrapper, ModelTransformer } from '@aws-amplify/graphql-model-transformer';
import { setKeySnippet, ensureCompositeKeySnippet } from './resolvers/';

export type Nullable<T> = T | null;
export type OptionalAndNullable<T> = Partial<Nullable<T>>;

export type KeyDirectiveConfiguration = {
  name?: OptionalAndNullable<string>;
  fields: string[];
  queryField: OptionalAndNullable<string>;
};

export const directiveDefinition = /* GraphQl */ `
directive @key(
    name: String,
    fields: [String!]!,
    queryField: String
)repeatable on OBJECT
`;

export class KeyTransformer extends TransformerModelEnhancerBase implements TransformerModelEnhancementProvider {
  [x: string]: any;
  private typesWithKeyDirective: Set<string> = new Set();
  /**
   * A Map to hold the directive configuration
   */
  private keyDirectiveConfig: Map<string, KeyDirectiveConfiguration[]> = new Map();
  private resolverMap: Record<string, TransformerResolverProvider> = {};
  constructor() {
    super('amplify-key-transformer', directiveDefinition);
  }

  object = (definition: ObjectTypeDefinitionNode, directive: DirectiveNode): void => {
    const typeName = definition.name.value;
    const directiveWrapped: DirectiveWrapper = new DirectiveWrapper(directive);
    const options = directiveWrapped.getArguments({
      name: '',
      fields: [],
      queryField: '',
    });
    if (this.keyDirectiveConfig.has(typeName)) {
      this.keyDirectiveConfig.get(typeName)?.push(options);
    } else {
      this.keyDirectiveConfig.set(typeName, Array(options));
    }
    this.typesWithKeyDirective.add(typeName);
  };

  /**
   * 1. There may only be 1 @key without a name (specifying the primary key)
   * 2. There may only be 1 @key with a given name.
   * 3. @key must only reference existing scalar fields that map to DynamoDB S, N, or B.
   * 4. A primary key must not include a 'queryField'.
   * 5. If there is no primary sort key, make sure there are no more LSIs.
   * 6. Add check for the fields to be xplicit
   * @param ctx Transfomer Context provider for the validation step
   */
  validate = (ctx: TransformerValidationStepContextProvider) => {
    for (const keyTypeName of this.typesWithKeyDirective) {
      const keyDirectiveConfigArr = this.keyDirectiveConfig.get(keyTypeName);
      keyDirectiveConfigArr?.forEach(keyDirectiveArgs => {
        if (!keyDirectiveArgs.name) {
          // 1. Make sure there are no more directives without a name.
          keyDirectiveConfigArr?.forEach(OtherKeyDirectiveArgs => {
            if (OtherKeyDirectiveArgs !== keyDirectiveArgs && !OtherKeyDirectiveArgs.name) {
              throw new InvalidDirectiveError(`You may only supply one primary @key on type '${keyTypeName}'.`);
            }
            // 5. If there is no primary sort key, make sure there are no more LSIs.
            const hasPrimarySortKey = keyDirectiveArgs.fields.length > 1;
            const primaryHashField = keyDirectiveArgs.fields[0];
            const otherHashField = OtherKeyDirectiveArgs.fields[0];
            if (
              OtherKeyDirectiveArgs !== keyDirectiveArgs &&
              !hasPrimarySortKey &&
              // If the primary key and other key share the first field and are not the same directive it is an LSI.
              primaryHashField === otherHashField
            ) {
              throw new InvalidDirectiveError(
                `Invalid @key "${OtherKeyDirectiveArgs.name}". You may not create a @key where the first field in 'fields' ` +
                  `is the same as that of the primary @key unless the primary @key has multiple 'fields'. ` +
                  `You cannot have a local secondary index without a sort key in the primary index.`,
              );
            }
          });
          // 4. Make sure that a 'queryField' is not included on a primary @key.
          if (keyDirectiveArgs.queryField) {
            throw new InvalidDirectiveError(`You cannot pass 'queryField' to the primary @key on type '${keyTypeName}'.`);
          }
        } else {
          // 2. Make sure there are no more directives with the same name.
          keyDirectiveConfigArr?.forEach(OtherKeyDirectiveArgs => {
            if (OtherKeyDirectiveArgs !== keyDirectiveArgs && OtherKeyDirectiveArgs.name === keyDirectiveArgs.name) {
              throw new InvalidDirectiveError(
                `You may only supply one @key with the name '${keyDirectiveArgs.name}' on type '${keyTypeName}'.`,
              );
            }
          });
        }
        // undertsand and change logic here
        // 3. Check that fields exists and are valid key types.
        const fieldMap = new Map();
        const definition = ctx.output.getObject(keyTypeName)!;
        for (const field of definition.fields!) {
          fieldMap.set(field.name.value, field);
        }
        for (const fieldName of keyDirectiveArgs.fields) {
          if (!fieldMap.has(fieldName)) {
            const checkedKeyName = keyDirectiveArgs.name ? keyDirectiveArgs.name : '<unnamed>';
            throw new InvalidDirectiveError(
              `You cannot specify a nonexistent field '${fieldName}' in @key '${checkedKeyName}' on type '${keyTypeName}'.`,
            );
          } else {
            const existingField = fieldMap.get(fieldName);
            const ddbKeyType = attributeTypeFromType(existingField.type, ctx);
            if (this.isPrimaryKey(keyDirectiveArgs) && !isNonNullType(existingField.type)) {
              throw new InvalidDirectiveError(`The primary @key on type '${keyTypeName}' must reference non-null fields.`);
            } else if (ddbKeyType !== 'S' && ddbKeyType !== 'N' && ddbKeyType !== 'B') {
              throw new InvalidDirectiveError(`A @key on type '${keyTypeName}' cannot reference non-scalar field ${fieldName}.`);
            }
          }
        }
      });
    }
  };

  prepare = (context: TransformerPrepareStepContextProvider) => {
    for (const keyTypeName of this.typesWithKeyDirective) {
      const type = context.output.getObject(keyTypeName);
      context.providerRegistry.addDataSourceEnhancer(type!, this);
    }
  };

  /**
   * Update the structural components of the schema that are relevant to the new index structures.
   *
   * Updates:
   * 1. getX with new primary key information.
   * 2. listX with new primary key information.
   *
   * Creates:
   * 1. A query field for each secondary index.
   */

  transformSchema = (ctx: TranformerTransformSchemaStepContextProvider): void => {
    for (const keyTypeName of this.typesWithKeyDirective) {
      const keyDirectiveConfigArr = this.keyDirectiveConfig.get(keyTypeName);
      keyDirectiveConfigArr?.forEach(keyDirectiveConfig => {
        this.updateQueryFields(keyDirectiveConfig, ctx, keyTypeName);
        this.updateInputObjects(keyDirectiveConfig, ctx, keyTypeName);
        const isPrimaryKey = this.isPrimaryKey(keyDirectiveConfig);
        if (isPrimaryKey) {
          this.removeAutoCreatedPrimaryKey(ctx, keyTypeName);
        }
      });
    }
  };

  generateResolvers = (ctx: TransformerContextProvider): void => {
    for (const keyTypeName of this.typesWithKeyDirective) {
      const def = ctx.output.getObject(keyTypeName)!;
      const keyDirectiveConfigArr = this.keyDirectiveConfig.get(keyTypeName)!;
      keyDirectiveConfigArr.forEach(keyDirectiveConfig => {
        // add / update primary key and GSI
        const tableLogicalName = `${def.name.value}Table`;
        const stack = ctx.stackManager.getStackFor(tableLogicalName, def.name.value);
        const keySchemaArgs = keySchema(keyDirectiveConfig);
        const attrDefs = attributeDefinitions(keyDirectiveConfig, def, ctx);
        const tableIndexProps = this.getIndexStructures(keyDirectiveConfig, keyTypeName);
        Aspects.of(stack).add(new DynamoDBTable(tableIndexProps, keySchemaArgs, attrDefs));

        // update resolvers
        this.updateQueryResolvers(keyDirectiveConfig, ctx, keyTypeName);
        this.updateMutationResolvers(keyDirectiveConfig, ctx, keyTypeName);
        //this.createKeyResolver(keyDirectiveConfig, ctx, keyTypeName);
      });
    }
  };

  /**
   * Update the existing @model table's index structures. Includes primary key, GSI, and LSIs.
   * @param definition The object type definition node.
   * @param directive The @key directive
   * @param ctx The transformer context
   */

  getIndexStructures = (keyDirectiveArgs: KeyDirectiveConfiguration, keyTypeName: string): TableKeyType => {
    if (this.isPrimaryKey(keyDirectiveArgs)) {
      // Set the table's primary key using the @key definition.
      return { isPrimary: true };
    } else {
      // Return a GSI/LSI Config.
      return this.appendSecondaryIndex(keyDirectiveArgs, keyTypeName);
    }
  };

  /**
   * Add a LSI or GSI to the table as defined by a @key.
   * @param definition The object type definition node.
   * @param directive The @key directive
   * @param ctx The transformer context
   */
  appendSecondaryIndex = (keyDirectiveArgs: KeyDirectiveConfiguration, keyTypeName: string): TableKeyType => {
    const ks = keySchema(keyDirectiveArgs);
    const primaryKeyDirective = this.keyDirectiveConfig.get(keyTypeName)!.find(element => this.isPrimaryKey(element));
    const primaryPartitionKeyName: string = primaryKeyDirective ? primaryKeyDirective.fields[0] : 'id';
    const baseIndexProperties: TableKeyType = {
      isPrimary: false,
      index: { indexProps: { indexName: keyDirectiveArgs.name! }, indexType: IndexType.GSI },
    };
    if (primaryPartitionKeyName === ks[0].attributeName) {
      // This is an LSI.
      // Add the new secondary index and update the table's attribute definitions.
      baseIndexProperties.index = Object.assign(baseIndexProperties.index, { indexProps: { indexType: IndexType.LSI } });
    }
    return baseIndexProperties;
  };

  generateGetResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    // const getResolver = ctx.resolvers.getResolver(typeName,fieldName);
    // const data = getResolver.add
    // console.log(getResolver);
    // // if (!this.resolverMap[resolverKey]) {
    // //   this.resolverMap[resolverKey] = ctx.resolvers.generateQueryResolver(
    // //     typeName,
    // //     fieldName,
    // //     dataSource,
    // //     MappingTemplate.s3MappingTemplateFromString(generateGetRequestTemplate(), `${typeName}.${fieldName}.req.vtl`),
    // //     MappingTemplate.s3MappingTemplateFromString(generateDefaultResponseMappingTemplate(), `${typeName}.${fieldName}.res.vtl`),
    // //   );
    // // }
    return this.resolverMap['resolverKey'];
  };

  generateListResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateUpdateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateDeleteResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateOnCreateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateOnUpdateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateOnDeleteResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  generateSyncResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  getQueryFieldNames = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
  ): Set<{ fieldName: string; typeName: string; type: QueryFieldType }> => {
    return new Set();
  };

  getMutationFieldNames = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
  ): Set<{ fieldName: string; typeName: string; type: MutationFieldType }> => {
    return new Set();
  };

  getSubscriptionFieldNames = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
  ): Set<{
    fieldName: string;
    typeName: string;
    type: SubscriptionFieldType;
  }> => {
    return new Set();
  };

  generateCreateResolver = (
    ctx: TransformerContextProvider,
    type: ObjectTypeDefinitionNode,
    typeName: string,
    fieldName: string,
  ): TransformerResolverProvider => {
    return this.resolverMap['test'];
  };

  getInputs = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
    operation: {
      fieldName: string;
      typeName: string;
      type: QueryFieldType | MutationFieldType | SubscriptionFieldType;
    },
  ): InputValueDefinitionNode[] => {
    return [];
  };

  getOutputType = (
    ctx: TranformerTransformSchemaStepContextProvider,
    type: ObjectTypeDefinitionNode,
    operation: {
      fieldName: string;
      typeName: string;
      type: QueryFieldType | MutationFieldType | SubscriptionFieldType;
    },
  ): ObjectTypeDefinitionNode => {
    return <ObjectTypeDefinitionNode>type;
  };

  getDataSourceResource = (ctx: TransformerContextProvider, type: ObjectTypeDefinitionNode): DataSourceInstance => {
    // Todo: add sanity check to ensure the type has an table
    return this.ddbTableMap[type.name.value];
  };

  getDataSourceType = (): AppSyncDataSourceType => {
    return AppSyncDataSourceType.AMAZON_DYNAMODB;
  };

  /**
   * Returns true if the directive specifies a primary key.
   * @param keyDirectiveArgs @key directive arguments
   */

  private isPrimaryKey = (keyDirectiveArgs: KeyDirectiveConfiguration) => {
    return !Boolean(keyDirectiveArgs.name);
  };

  /**
   * Updates query fields to include any arguments required by the key structures.
   * @param definition The object type definition node.
   * @param directive The @key directive
   * @param ctx The transformer context
   */
  updateQueryFields = (
    keyDirectiveArgs: KeyDirectiveConfiguration,
    ctx: TranformerTransformSchemaStepContextProvider,
    keyTypeName: string,
  ) => {
    // get related type queries
    this.updateGetField(keyDirectiveArgs, ctx, keyTypeName);
    this.updateListField(keyDirectiveArgs, ctx, keyTypeName);
    this.ensureQueryField(keyDirectiveArgs, ctx, keyTypeName);
  };

  // If the get field exists, update its arguments with primary key information.
  updateGetField = (
    keyDirectiveArgs: KeyDirectiveConfiguration,
    ctx: TranformerTransformSchemaStepContextProvider,
    keyTypeName: string,
  ) => {
    if (this.isPrimaryKey(keyDirectiveArgs)) {
      const def = ctx.output.getObject(keyTypeName)!;
      const modelProviderQueries = (ctx.providerRegistry.getDataSourceProvider(def) as ModelTransformer).getQueryFieldNames(ctx, def);
      let getQuery = ctx.output.getQuery();
      //By default takes a single argument named 'id'. Replace it with the updated primary key structure.
      let getField: FieldDefinitionNode = getQuery?.fields?.find(field => {
        for (const queryField of modelProviderQueries.values()) {
          if (queryField.type === QueryFieldType.GET) {
            return field.name.value === queryField.fieldName;
          }
        }
      }) as FieldDefinitionNode;
      const getArguments = keyDirectiveArgs.fields.map(keyAttributeName => {
        const keyField = def.fields!.find(field => field.name.value === keyAttributeName);
        const keyArgument = makeInputValueDefinition(keyAttributeName, makeNonNullType(makeNamedType(getBaseType(keyField!.type))));
        return keyArgument;
      });
      console.log(getArguments);
      getField = { ...getField, arguments: getArguments };
      console.log(getField);
      getQuery = { ...getQuery!, fields: getQuery?.fields?.map(field => (field.name.value === getField.name.value ? getField : field)) };
      console.log(getQuery);
      ctx.output.updateObject(getQuery);
    }
  };

  // If the list field exists, update its arguments with primary key information.
  updateListField = (
    keyDirectiveArgs: KeyDirectiveConfiguration,
    ctx: TranformerTransformSchemaStepContextProvider,
    keyTypeName: string,
  ) => {
    if (this.isPrimaryKey(keyDirectiveArgs)) {
      // By default takes a single argument named 'id'. Replace it with the updated primary key structure.
      const def = ctx.output.getObject(keyTypeName)!;
      const modelProviderQueries = (ctx.providerRegistry.getDataSourceProvider(def) as ModelTransformer).getQueryFieldNames(ctx, def!);
      let getQuery = ctx.output.getQuery();
      //By default takes a single argument named 'id'. Replace it with the updated primary key structure.
      let listField: FieldDefinitionNode = getQuery?.fields?.find(field => {
        for (const queryField of modelProviderQueries.values()) {
          if (queryField.type === QueryFieldType.LIST) {
            return field.name.value === queryField.fieldName;
          }
        }
      }) as FieldDefinitionNode;
      console.log(listField);
      let listArguments: InputValueDefinitionNode[] = [...listField.arguments!];
      if (keyDirectiveArgs.fields.length > 2) {
        listArguments = addCompositeSortKey(def, keyDirectiveArgs, listArguments);
        listArguments = addHashField(def, keyDirectiveArgs, listArguments);
      } else if (keyDirectiveArgs.fields.length === 2) {
        listArguments = addSimpleSortKey(ctx, def, keyDirectiveArgs, listArguments);
        listArguments = addHashField(def, keyDirectiveArgs, listArguments);
      } else {
        listArguments = addHashField(def, keyDirectiveArgs, listArguments);
      }
      listArguments.push(makeInputValueDefinition('sortDirection', makeNamedType('ModelSortDirection')));
      listField = { ...listField, arguments: listArguments };
      getQuery = { ...getQuery!, fields: getQuery!.fields!.map(field => (field.name.value === listField.name.value ? listField : field)) };
      ctx.output.updateObject(getQuery);
    }
  };

  // If this is a secondary key and a queryField has been provided, create the query field.
  private ensureQueryField = (
    keyDirectiveArgs: KeyDirectiveConfiguration,
    ctx: TranformerTransformSchemaStepContextProvider,
    keyTypeName: string,
  ) => {
    if (keyDirectiveArgs.queryField && !this.isPrimaryKey(keyDirectiveArgs)) {
      const definition = ctx.output.getObject(keyTypeName)!;
      let queryType = ctx.output.getQuery();
      let queryArguments: InputValueDefinitionNode[] = [];
      if (keyDirectiveArgs.fields.length > 2) {
        queryArguments = addCompositeSortKey(definition, keyDirectiveArgs, queryArguments);
        queryArguments = addHashField(definition, keyDirectiveArgs, queryArguments);
      } else if (keyDirectiveArgs.fields.length === 2) {
        queryArguments = addSimpleSortKey(ctx, definition, keyDirectiveArgs, queryArguments);
        queryArguments = addHashField(definition, keyDirectiveArgs, queryArguments);
      } else {
        queryArguments = addHashField(definition, keyDirectiveArgs, queryArguments);
      }
      queryArguments.push(makeInputValueDefinition('sortDirection', makeNamedType('ModelSortDirection')));
      const queryField = makeConnectionField(keyDirectiveArgs.queryField, definition.name.value, queryArguments);
      queryType = {
        ...queryType!,
        fields: [...queryType!.fields!, queryField],
      };
      ctx.output.updateObject(queryType);
    }
  };

  // Update the create, update, and delete input objects to account for any changes to the primary key.
  private updateInputObjects = (
    keyDirectiveArgs: KeyDirectiveConfiguration,
    ctx: TranformerTransformSchemaStepContextProvider,
    keyTypeName: string,
  ) => {
    if (this.isPrimaryKey(keyDirectiveArgs)) {
      const definition = ctx.output.getObject(keyTypeName);
      const hasIdField = definition!.fields!.find(f => f.name.value === 'id');
      if (!hasIdField) {
        const createInput: InputObjectTypeDefinitionNode = ctx.output.getType(
          ModelResourceIDs.ModelCreateInputObjectName(definition!.name.value),
        ) as InputObjectTypeDefinitionNode;
        if (createInput) {
          ctx.output.putType(replaceCreateInput(createInput));
        }
      }

      const updateInput = ctx.output.getType(
        ModelResourceIDs.ModelUpdateInputObjectName(definition!.name.value),
      ) as InputObjectTypeDefinitionNode;
      if (updateInput) {
        ctx.output.putType(replaceUpdateInput(updateInput, keyDirectiveArgs.fields));
      }
      const deleteInput = ctx.output.getType(
        ModelResourceIDs.ModelDeleteInputObjectName(definition!.name.value),
      ) as InputObjectTypeDefinitionNode;
      if (deleteInput) {
        ctx.output.putType(replaceDeleteInput(definition!, deleteInput, keyDirectiveArgs.fields));
      }
    }
  };

  removeAutoCreatedPrimaryKey = (ctx: TranformerTransformSchemaStepContextProvider, keyTypeName: string): void => {
    const definition = ctx.output.getObject(keyTypeName)!;
    const schemaHasIdField = definition.fields!.find(f => f.name.value === 'id');
    if (!schemaHasIdField) {
      const obj = ctx.output.getObject(definition.name.value)!;
      const fields = obj.fields!.filter(f => f.name.value !== 'id');
      const newObj: ObjectTypeDefinitionNode = {
        ...obj,
        fields,
      };
      ctx.output.updateObject(newObj);
    }
  };
  // update resolver code
  updateQueryResolvers = (keyDirectiveArgs: KeyDirectiveConfiguration, ctx: TransformerContextProvider, keyTypeName: string): void => {
    const def = ctx.output.getObject(keyTypeName);
    const modelProviderQueries = (ctx.providerRegistry.getDataSourceProvider(def!) as ModelTransformer).getQueryFieldNames(ctx, def!);
    for (const queryField of modelProviderQueries.values()) {
      let resolver;
      resolver = ctx.resolvers.getResolver(queryField.typeName, queryField.fieldName);
      switch (queryField.type) {
        case QueryFieldType.GET:
          if (this.isPrimaryKey(keyDirectiveArgs)) {
            resolver = ctx.resolvers.getResolver(queryField.typeName, queryField.fieldName);
            (resolver as TransformerResolverProvider).addToSlot(
              'init',
              MappingTemplate.s3MappingTemplateFromString(
                setKeySnippet(keyDirectiveArgs),
                `${queryField.typeName}.${queryField.fieldName}.{slotName}.{slotIndex}.req.vtl`,
              ),
            );
          }
          break;
        case QueryFieldType.LIST:
          if (this.isPrimaryKey(keyDirectiveArgs)) {
            (resolver as TransformerResolverProvider).addToSlot(
              'init',
              MappingTemplate.s3MappingTemplateFromString(
                // set snippet for list resolver
                setKeySnippet(keyDirectiveArgs),
                `${queryField.typeName}.${queryField.fieldName}.{slotName}.{slotIndex}.req.vtl`,
              ),
            );
          }
          break;
        case QueryFieldType.SYNC:
          if (this.isPrimaryKey(keyDirectiveArgs)) {
            (resolver as TransformerResolverProvider).addToSlot(
              'init',
              MappingTemplate.s3MappingTemplateFromString(
                // set snippet for sync resolver
                setKeySnippet(keyDirectiveArgs),
                `${queryField.typeName}.${queryField.fieldName}.{slotName}.{slotIndex}.req.vtl`,
              ),
            );
          } else {
            // generate snippet for sync resolver
          }
          break;
        default:
          throw new Error('Unkown query field type');
      }
    }
  };

  // update mutations code
  updateMutationResolvers = (keyDirectiveArgs: KeyDirectiveConfiguration, ctx: TransformerContextProvider, keyTypeName: string): void => {
    const def = ctx.output.getObject(keyTypeName);
    const modelProviderMutations = (ctx.providerRegistry.getDataSourceProvider(def!) as ModelTransformer).getMutationFieldNames(ctx, def!);
    for (const mutationField of modelProviderMutations.values()) {
      let resolver;
      resolver = ctx.resolvers.getResolver(mutationField.typeName, mutationField.fieldName);
      switch (mutationField.type) {
        case MutationFieldType.CREATE:
          if (this.isPrimaryKey(keyDirectiveArgs)) {
            resolver = ctx.resolvers.getResolver(mutationField.typeName, mutationField.fieldName);
            (resolver as TransformerResolverProvider).addToSlot(
              'init',
              MappingTemplate.s3MappingTemplateFromString(
                joinSnippets([setKeySnippet(keyDirectiveArgs, true), ensureCompositeKeySnippet(keyDirectiveArgs)]),
                `${mutationField.typeName}.${mutationField.fieldName}.{slotName}.{slotIndex}.req.vtl`,
              ),
            );
          } else {
            // when @key present without primary key
          }
          break;
        case MutationFieldType.UPDATE:
          if (this.isPrimaryKey(keyDirectiveArgs)) {
            console.log(keyDirectiveArgs);
            // update changes
          } else {
            // chnages when @key is present
          }
          break;
        case MutationFieldType.DELETE:
          if (this.isPrimaryKey(keyDirectiveArgs)) {
            (resolver as TransformerResolverProvider).addToSlot(
              'init',
              MappingTemplate.s3MappingTemplateFromString(
                // set snippet for sync resolver
                setKeySnippet(keyDirectiveArgs),
                `${mutationField.typeName}.${mutationField.fieldName}.{slotName}.{slotIndex}.req.vtl`,
              ),
            );
          } else {
            // generate snippet for sync resolver
          }
          break;
        default:
          throw new Error('Unkown query field type');
      }
    }
  };
}

export function attributeTypeFromType(type: TypeNode, ctx: TransformerValidationStepContextProvider) {
  const baseTypeName = getBaseType(type);
  const ofType = ctx.output.getType(baseTypeName);
  if (ofType && ofType.kind === Kind.ENUM_TYPE_DEFINITION) {
    return 'S';
  }
  return attributeTypeFromScalar(type);
}

function addHashField(
  definition: ObjectTypeDefinitionNode,
  args: KeyDirectiveConfiguration,
  elems: InputValueDefinitionNode[],
): InputValueDefinitionNode[] {
  let hashFieldName = args.fields[0];
  const hashField = definition.fields!.find(field => field.name.value === hashFieldName);
  const hashKey = makeInputValueDefinition(hashFieldName, makeNamedType(getBaseType(hashField!.type)));
  return [hashKey, ...elems];
}

function addSimpleSortKey(
  ctx: TranformerTransformSchemaStepContextProvider,
  definition: ObjectTypeDefinitionNode,
  args: KeyDirectiveConfiguration,
  elems: InputValueDefinitionNode[],
): InputValueDefinitionNode[] {
  let sortKeyName = args.fields[1];
  const sortField = definition.fields!.find(field => field.name.value === sortKeyName);
  const baseType = getBaseType(sortField!.type);
  const resolvedTypeIfEnum = ctx.output.getObject(baseType) ? 'String' : undefined;
  const resolvedType = resolvedTypeIfEnum ? resolvedTypeIfEnum : baseType;
  const hashKey = makeInputValueDefinition(sortKeyName, makeNamedType(ModelResourceIDs.ModelKeyConditionInputTypeName(resolvedType)));
  return [hashKey, ...elems];
}

function addCompositeSortKey(
  definition: ObjectTypeDefinitionNode,
  args: KeyDirectiveConfiguration,
  elems: InputValueDefinitionNode[],
): InputValueDefinitionNode[] {
  let sortKeyNames = args.fields.slice(1);
  const compositeSortKeyName = toCamelCase(sortKeyNames);
  const hashKey = makeInputValueDefinition(
    compositeSortKeyName,
    makeNamedType(ModelResourceIDs.ModelCompositeKeyConditionInputTypeName(definition.name.value, toUpper(args.name || 'Primary'))),
  );
  return [hashKey, ...elems];
}

// Key fields are non-nullable, non-key fields are not non-nullable.
function replaceUpdateInput(input: InputObjectTypeDefinitionNode, keyFields: string[]): InputObjectTypeDefinitionNode {
  console.log(input);
  console.log(keyFields);

  return {
    ...input,
    fields: input.fields!.map(f => {
      if (keyFields.find(k => k === f.name.value)) {
        return makeInputValueDefinition(f.name.value, wrapNonNull(withNamedNodeNamed(f.type, getBaseType(f.type))));
      }
      return f;
    }),
  };
}

// Remove the id field added by @model transformer
function replaceCreateInput(input: InputObjectTypeDefinitionNode): InputObjectTypeDefinitionNode {
  return {
    ...input,
    fields: input.fields!.filter(f => f.name.value !== 'id'),
  };
}

// Key fields are non-nullable, non-key fields are not non-nullable.
function replaceDeleteInput(
  definition: ObjectTypeDefinitionNode,
  input: InputObjectTypeDefinitionNode,
  keyFields: string[],
): InputObjectTypeDefinitionNode {
  const idFields = primaryIdFields(definition, keyFields);
  const existingFields = input.fields!.filter(
    f => !(idFields.find(pf => pf.name.value === f.name.value) || (getBaseType(f.type) === 'ID' && f.name.value === 'id')),
  );

  return {
    ...input,
    fields: [...idFields, ...existingFields],
  };
}

function primaryIdFields(definition: ObjectTypeDefinitionNode, keyFields: string[]): InputValueDefinitionNode[] {
  return keyFields.map(keyFieldName => {
    const keyField = definition.fields!.find(field => field.name.value === keyFieldName);
    return makeInputValueDefinition(keyFieldName, makeNonNullType(makeNamedType(getBaseType(keyField!.type))));
  });
}

function joinSnippets(lines: string[]): string {
  return lines.join('\n');
}

/**
 * Return a list of attribute definitions given a @key directive arguments and an object definition.
 * @param args The arguments passed to @key.
 * @param def The object type definition containing the @key.
 */
export function attributeDefinitions(
  args: KeyDirectiveConfiguration,
  def: ObjectTypeDefinitionNode,
  ctx: TransformerContextProvider,
): AttributeDefinition[] {
  const fieldMap = new Map();
  for (const field of def.fields!) {
    fieldMap.set(field.name.value, field);
  }
  if (args.fields.length > 2) {
    const hashName = args.fields[0];
    const condensedSortKey = condenseRangeKey(args.fields.slice(1));
    return [
      { attributeName: hashName, attributeType: attributeTypeFromType(fieldMap.get(hashName).type, ctx) },
      { attributeName: condensedSortKey, attributeType: 'S' },
    ];
  } else if (args.fields.length === 2) {
    const hashName = args.fields[0];
    const sortName = args.fields[1];
    return [
      { attributeName: hashName, attributeType: attributeTypeFromType(fieldMap.get(hashName).type, ctx) },
      { attributeName: sortName, attributeType: attributeTypeFromType(fieldMap.get(sortName).type, ctx) },
    ];
  } else {
    const fieldName = args.fields[0];
    return [{ attributeName: fieldName, attributeType: attributeTypeFromType(fieldMap.get(fieldName).type, ctx) }];
  }
}

function condenseRangeKey(fields: string[]) {
  return fields.join(ModelResourceIDs.ModelCompositeKeySeparator());
}

/**
 * Return a key schema given @key directive arguments.
 * @param args The arguments of the @key directive.
 */
export function keySchema(args: KeyDirectiveConfiguration): KeySchema[] {
  if (args.fields.length > 1) {
    const condensedSortKey = condenseRangeKey(args.fields.slice(1));
    return [
      { attributeName: args.fields[0], keyType: 'HASH' },
      { attributeName: condensedSortKey, keyType: 'RANGE' },
    ];
  } else {
    return [{ attributeName: args.fields[0], keyType: 'HASH' }];
  }
}
